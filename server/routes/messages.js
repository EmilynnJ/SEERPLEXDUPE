const express = require('express');
const router = express.Router();
const { prisma, messageHelpers } = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const { validateMessage } = require('../middleware/validation');

// Helper to generate conversation ID
function generateConversationId(id1, id2) {
  const ids = [id1, id2].map(String).sort();
  return `${ids[0]}_${ids[1]}`;
}

// Send a message
router.post('/send', authMiddleware, validateMessage, async (req, res) => {
  try {
    const { receiverId, content, messageType = 'text', sessionId = null } = req.body;
    const senderId = req.user.userId;

    // Validate receiver exists
    const receiver = await prisma.user.findUnique({ where: { id: receiverId } });
    if (!receiver) {
      return res.status(404).json({ message: 'Receiver not found' });
    }

    // Cannot message yourself
    if (senderId === receiverId) {
      return res.status(400).json({ message: 'Cannot send message to yourself' });
    }

    // Generate conversation ID
    const conversationId = generateConversationId(senderId, receiverId);

    // Create message via Prisma
    const message = await messageHelpers.createMessage({
      senderId,
      recipientId: receiverId,
      sessionId,
      conversationId,
      content,
      messageType,
      metadata: {
        clientIP: req.ip,
        userAgent: req.get('User-Agent')
      }
    });

    // Emit real-time message via socket.io
    const io = req.app.get('io');
    if (io) {
      io.emit('new-message', {
        receiverId,
        message: {
          id: message.id,
          conversationId,
          content: message.content,
          messageType: message.messageType,
          sender: {
            id: message.sender.id,
            name: message.sender.profile?.name || 'Anonymous',
            avatar: message.sender.profile?.avatar,
            role: message.sender.role
          },
          createdAt: message.createdAt
        }
      });
    }

    res.status(201).json({
      success: true,
      message: {
        id: message.id,
        conversationId,
        content: message.content,
        messageType: message.messageType,
        createdAt: message.createdAt,
        sender: {
          id: message.sender.id,
          name: message.sender.profile?.name || 'Anonymous',
          avatar: message.sender.profile?.avatar
        }
      }
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      message: 'Failed to send message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get conversation history
router.get('/conversation/:conversationId', authMiddleware, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.userId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before;
    const after = req.query.after;

    // Authorization check
    const [u1, u2] = conversationId.split('_');
    if (userId !== u1 && userId !== u2) {
      return res.status(403).json({ message: 'Not authorized to view this conversation' });
    }

    // Build query filters
    const where = { conversationId, isDeleted: false };
    if (before) where.createdAt = { ...where.createdAt, lt: new Date(before) };
    if (after) where.createdAt = { ...where.createdAt, gt: new Date(after) };

    const skip = (page - 1) * limit;
    const messages = await prisma.message.findMany({
      where,
      include: {
        sender: { select: { id: true, profile: true, role: true } },
        recipient: true
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit
    });

    // Mark as read
    await messageHelpers.markAsRead(conversationId, userId);

    res.json({
      success: true,
      messages,
      conversationId,
      pagination: {
        currentPage: page,
        limit,
        hasMore: messages.length === limit
      }
    });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({
      message: 'Failed to retrieve conversation',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get recent conversations
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const limit = parseInt(req.query.limit) || 20;

    // Fetch last message per conversation
    const lastMessages = await prisma.message.findMany({
      where: {
        OR: [{ senderId: userId }, { recipientId: userId }],
        isDeleted: false
      },
      distinct: ['conversationId'],
      orderBy: { createdAt: 'desc' },
      include: {
        sender: { select: { id: true, profile: true, role: true, readerSettings: true } },
        recipient: { select: { id: true, profile: true, role: true, readerSettings: true } }
      },
      take: limit
    });

    const formatted = await Promise.all(lastMessages.map(async msg => {
      const other = msg.senderId === userId ? msg.recipient : msg.sender;
      const unreadCount = await messageHelpers.getUnreadCount(userId);
      return {
        conversationId: msg.conversationId,
        otherParticipant: {
          id: other.id,
          name: other.profile?.name || 'Anonymous',
          avatar: other.profile?.avatar,
          role: other.role,
          isOnline: other.role === 'reader' ? other.readerSettings?.isOnline : false
        },
        lastMessage: {
          content: msg.content,
          messageType: msg.messageType,
          createdAt: msg.createdAt,
          isFromMe: msg.senderId === userId
        },
        unreadCount
      };
    }));

    res.json({ success: true, conversations: formatted });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({
      message: 'Failed to retrieve conversations',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get unread message count
router.get('/unread-count', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const unreadCount = await messageHelpers.getUnreadCount(userId);
    res.json({ success: true, unreadCount });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({
      message: 'Failed to get unread count',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Mark single message as read
router.patch('/:messageId/read', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.userId;
    const msg = await prisma.message.findUnique({ where: { id: messageId } });
    if (!msg || msg.recipientId !== userId) {
      return res.status(404).json({ message: 'Message not found' });
    }
    await prisma.message.update({
      where: { id: messageId },
      data: { isRead: true, readAt: new Date() }
    });
    res.json({ success: true, message: 'Message marked as read' });
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({
      message: 'Failed to mark message as read',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Mark entire conversation as read
router.patch('/conversation/:conversationId/read', authMiddleware, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.userId;
    const [u1, u2] = conversationId.split('_');
    if (userId !== u1 && userId !== u2) {
      return res.status(403).json({ message: 'Not authorized to modify this conversation' });
    }
    const result = await messageHelpers.markAsRead(conversationId, userId);
    res.json({
      success: true,
      message: 'Conversation marked as read',
      modifiedCount: result.count
    });
  } catch (error) {
    console.error('Mark conversation as read error:', error);
    res.status(500).json({
      message: 'Failed to mark conversation as read',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Edit message
router.patch('/:messageId/edit', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content } = req.body;
    const userId = req.user.userId;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: 'Message content is required' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ message: 'Message must be less than 2000 characters' });
    }

    const msg = await prisma.message.findUnique({ where: { id: messageId } });
    if (!msg || msg.senderId !== userId) {
      return res.status(404).json({ message: 'Message not found or not authorized' });
    }

    const fifteenAgo = new Date(Date.now() - 15 * 60 * 1000);
    if (msg.createdAt < fifteenAgo) {
      return res.status(400).json({ message: 'Message is too old to edit' });
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        originalContent: msg.content,
        content: content.trim(),
        isEdited: true,
        editedAt: new Date()
      }
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('message-edited', {
        messageId: updated.id,
        conversationId: updated.conversationId,
        newContent: updated.content,
        editedAt: updated.editedAt
      });
    }

    res.json({
      success: true,
      message: {
        id: updated.id,
        content: updated.content,
        isEdited: updated.isEdited,
        editedAt: updated.editedAt
      }
    });
  } catch (error) {
    console.error('Edit message error:', error);
    res.status(500).json({
      message: 'Failed to edit message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Delete (soft) message
router.delete('/:messageId', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.userId;
    const msg = await prisma.message.findUnique({ where: { id: messageId } });
    if (!msg || msg.senderId !== userId) {
      return res.status(404).json({ message: 'Message not found or not authorized' });
    }

    await prisma.message.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId
      }
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('message-deleted', {
        messageId,
        conversationId: msg.conversationId
      });
    }

    res.json({ success: true, message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({
      message: 'Failed to delete message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Add reaction to message
router.post('/:messageId/reaction', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user.userId;

    if (!emoji || typeof emoji !== 'string') {
      return res.status(400).json({ message: 'Valid emoji is required' });
    }

    const msg = await prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) {
      return res.status(404).json({ message: 'Message not found' });
    }

    const [u1, u2] = msg.conversationId.split('_');
    if (userId !== u1 && userId !== u2) {
      return res.status(403).json({ message: 'Not authorized to react to this message' });
    }

    const current = Array.isArray(msg.reactions) ? msg.reactions : [];
    const filtered = current.filter(r => r.userId !== userId);
    const reaction = { userId, emoji, createdAt: new Date().toISOString() };
    const newReactions = [...filtered, reaction];

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { reactions: newReactions }
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('message-reaction', {
        messageId,
        conversationId: msg.conversationId,
        userId,
        emoji,
        reactions: updated.reactions
      });
    }

    res.json({ success: true, message: 'Reaction added', reactions: updated.reactions });
  } catch (error) {
    console.error('Add reaction error:', error);
    res.status(500).json({
      message: 'Failed to add reaction',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Remove reaction from message
router.delete('/:messageId/reaction', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.userId;

    const msg = await prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) {
      return res.status(404).json({ message: 'Message not found' });
    }

    const current = Array.isArray(msg.reactions) ? msg.reactions : [];
    const newReactions = current.filter(r => r.userId !== userId);

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { reactions: newReactions }
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('message-reaction-removed', {
        messageId,
        conversationId: msg.conversationId,
        userId,
        reactions: updated.reactions
      });
    }

    res.json({ success: true, message: 'Reaction removed', reactions: updated.reactions });
  } catch (error) {
    console.error('Remove reaction error:', error);
    res.status(500).json({
      message: 'Failed to remove reaction',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;