const { prisma } = require('../lib/prisma');

class WebRTCSignaling {
  constructor(io) {
    this.io = io;
    this.activeSessions = new Map();
    this.userSockets = new Map();
    this.setupSocketHandlers();
  }

  setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`WebRTC: User connected - ${socket.id}`);

      // Register user with their socket
      socket.on('register-user', async (data) => {
        try {
          const { userId, token } = data;
          
          // Verify user exists and is active
          const user = await prisma.user.findUnique({
            where: { id: userId, isActive: true }
          });

          if (!user) {
            socket.emit('error', { message: 'Invalid user or user not active' });
            return;
          }

          this.userSockets.set(userId, socket.id);
          socket.userId = userId;
          socket.userRole = user.role;
          
          // Update user's last seen
          await prisma.user.update({
            where: { id: userId },
            data: { lastSeen: new Date() }
          });

          console.log(`WebRTC: User ${userId} (${user.role}) registered with socket ${socket.id}`);
          
          socket.emit('registered', { 
            userId, 
            role: user.role,
            isOnline: user.isOnline 
          });

        } catch (error) {
          console.error('WebRTC register user error:', error);
          socket.emit('error', { message: 'Failed to register user' });
        }
      });

      // Join a session room
      socket.on('join-session', async (data) => {
        try {
          const { sessionId, userId } = data;
          
          // Verify session exists and user is authorized
          const session = await prisma.session.findFirst({
            where: { sessionId },
            include: {
              client: true,
              reader: true
            }
          });
          
          if (!session) {
            socket.emit('error', { message: 'Session not found' });
            return;
          }

          const isAuthorized = session.client.id === userId || session.reader.id === userId;
          
          if (!isAuthorized) {
            socket.emit('error', { message: 'Not authorized for this session' });
            return;
          }

          // Join the session room
          socket.join(sessionId);
          socket.sessionId = sessionId;
          
          // Track active session
          if (!this.activeSessions.has(sessionId)) {
            this.activeSessions.set(sessionId, {
              participants: new Set(),
              session: session,
              startTime: new Date()
            });
          }
          
          this.activeSessions.get(sessionId).participants.add(socket.id);
          
          // Notify other participants
          socket.to(sessionId).emit('user-joined', {
            userId,
            socketId: socket.id,
            userRole: session.client.id === userId ? 'client' : 'reader',
            userName: session.client.id === userId ? session.client.name : session.reader.name,
            userAvatar: session.client.id === userId ? session.client.avatar : session.reader.avatar
          });

          // Send session info to joining user
          socket.emit('session-joined', {
            sessionId,
            sessionType: session.sessionType,
            status: session.status,
            rate: session.rate,
            startTime: session.startTime,
            participants: this.activeSessions.get(sessionId).participants.size,
            client: {
              id: session.client.id,
              name: session.client.name,
              avatar: session.client.avatar
            },
            reader: {
              id: session.reader.id,
              name: session.reader.name,
              avatar: session.reader.avatar
            }
          });

          console.log(`WebRTC: User ${userId} joined session ${sessionId}`);
          
        } catch (error) {
          console.error('WebRTC join session error:', error);
          socket.emit('error', { message: 'Failed to join session' });
        }
      });

      // Handle WebRTC offer
      socket.on('webrtc-offer', (data) => {
        const { sessionId, offer, targetUserId } = data;
        
        if (!socket.sessionId || socket.sessionId !== sessionId) {
          socket.emit('error', { message: 'Not in session' });
          return;
        }

        console.log(`WebRTC: Forwarding offer from ${socket.userId} to ${targetUserId || 'all'}`);

        // Forward offer to target user or broadcast
        if (targetUserId) {
          const targetSocketId = this.userSockets.get(targetUserId);
          if (targetSocketId) {
            this.io.to(targetSocketId).emit('webrtc-offer', {
              sessionId,
              offer,
              fromUserId: socket.userId
            });
          }
        } else {
          socket.to(sessionId).emit('webrtc-offer', {
            sessionId,
            offer,
            fromUserId: socket.userId
          });
        }
      });

      // Handle WebRTC answer
      socket.on('webrtc-answer', (data) => {
        const { sessionId, answer, targetUserId } = data;
        
        if (!socket.sessionId || socket.sessionId !== sessionId) {
          socket.emit('error', { message: 'Not in session' });
          return;
        }

        console.log(`WebRTC: Forwarding answer from ${socket.userId} to ${targetUserId || 'all'}`);

        // Forward answer to target user or broadcast
        if (targetUserId) {
          const targetSocketId = this.userSockets.get(targetUserId);
          if (targetSocketId) {
            this.io.to(targetSocketId).emit('webrtc-answer', {
              sessionId,
              answer,
              fromUserId: socket.userId
            });
          }
        } else {
          socket.to(sessionId).emit('webrtc-answer', {
            sessionId,
            answer,
            fromUserId: socket.userId
          });
        }
      });

      // Handle ICE candidates
      socket.on('webrtc-ice-candidate', (data) => {
        const { sessionId, candidate, targetUserId } = data;
        
        if (!socket.sessionId || socket.sessionId !== sessionId) {
          socket.emit('error', { message: 'Not in session' });
          return;
        }

        // Forward ICE candidate
        if (targetUserId) {
          const targetSocketId = this.userSockets.get(targetUserId);
          if (targetSocketId) {
            this.io.to(targetSocketId).emit('webrtc-ice-candidate', {
              sessionId,
              candidate,
              fromUserId: socket.userId
            });
          }
        } else {
          socket.to(sessionId).emit('webrtc-ice-candidate', {
            sessionId,
            candidate,
            fromUserId: socket.userId
          });
        }
      });

      // Handle session chat messages
      socket.on('session-message', async (data) => {
        try {
          const { sessionId, message, messageType = 'TEXT' } = data;
          
          if (!socket.sessionId || socket.sessionId !== sessionId) {
            socket.emit('error', { message: 'Not in session' });
            return;
          }

          const sessionData = this.activeSessions.get(sessionId);
          if (!sessionData) {
            socket.emit('error', { message: 'Session not active' });
            return;
          }

          // Get session info to determine receiver
          const session = sessionData.session;
          const receiverId = session.client.id === socket.userId ? session.reader.id : session.client.id;

          // Save message to database
          const savedMessage = await prisma.message.create({
            data: {
              senderId: socket.userId,
              receiverId,
              sessionId: session.id,
              conversationId: `session_${sessionId}`,
              content: message,
              messageType
            },
            include: {
              sender: {
                select: { id: true, name: true, avatar: true, role: true }
              }
            }
          });

          // Broadcast message to all participants in session
          const messageData = {
            id: savedMessage.id,
            sessionId,
            message,
            messageType,
            fromUserId: socket.userId,
            fromUserName: savedMessage.sender.name,
            fromUserAvatar: savedMessage.sender.avatar,
            timestamp: savedMessage.createdAt
          };

          this.io.to(sessionId).emit('session-message', messageData);
          
        } catch (error) {
          console.error('WebRTC session message error:', error);
          socket.emit('error', { message: 'Failed to send message' });
        }
      });

      // Handle connection quality updates
      socket.on('connection-quality', (data) => {
        const { sessionId, quality, stats } = data;
        
        if (!socket.sessionId || socket.sessionId !== sessionId) {
          return;
        }

        // Forward quality info to other participants
        socket.to(sessionId).emit('peer-connection-quality', {
          fromUserId: socket.userId,
          quality,
          stats,
          timestamp: new Date().toISOString()
        });
      });

      // Handle media state changes (mute/unmute, video on/off)
      socket.on('media-state-change', (data) => {
        const { sessionId, mediaType, enabled } = data;
        
        if (!socket.sessionId || socket.sessionId !== sessionId) {
          return;
        }

        // Broadcast media state change to other participants
        socket.to(sessionId).emit('peer-media-state-change', {
          fromUserId: socket.userId,
          mediaType, // 'audio' or 'video'
          enabled,
          timestamp: new Date().toISOString()
        });
      });

      // Handle session end
      socket.on('end-session', async (data) => {
        try {
          const { sessionId, reason = 'user_ended' } = data;
          
          if (!socket.sessionId || socket.sessionId !== sessionId) {
            socket.emit('error', { message: 'Not in session' });
            return;
          }

          // Notify all participants
          socket.to(sessionId).emit('session-ended', {
            sessionId,
            endedBy: socket.userId,
            reason,
            timestamp: new Date().toISOString()
          });

          // Clean up session
          await this.cleanupSession(sessionId, socket);
          
        } catch (error) {
          console.error('WebRTC end session error:', error);
        }
      });

      // Handle reader status updates
      socket.on('update-reader-status', async (data) => {
        try {
          if (socket.userRole !== 'READER') {
            socket.emit('error', { message: 'Only readers can update status' });
            return;
          }

          const { isOnline } = data;
          
          await prisma.user.update({
            where: { id: socket.userId },
            data: { 
              isOnline: Boolean(isOnline),
              lastSeen: new Date()
            }
          });

          // Broadcast status update
          socket.broadcast.emit('reader-status-update', {
            readerId: socket.userId,
            isOnline: Boolean(isOnline),
            timestamp: new Date().toISOString()
          });

          socket.emit('status-updated', { isOnline: Boolean(isOnline) });

        } catch (error) {
          console.error('WebRTC update reader status error:', error);
          socket.emit('error', { message: 'Failed to update status' });
        }
      });

      // Handle disconnection
      socket.on('disconnect', async () => {
        console.log(`WebRTC: User disconnected - ${socket.id}`);
        
        try {
          // Update user's last seen and set offline if reader
          if (socket.userId) {
            const updateData = { lastSeen: new Date() };
            
            if (socket.userRole === 'READER') {
              updateData.isOnline = false;
            }

            await prisma.user.update({
              where: { id: socket.userId },
              data: updateData
            });

            // Clean up user socket mapping
            this.userSockets.delete(socket.userId);

            // Broadcast reader offline status
            if (socket.userRole === 'READER') {
              socket.broadcast.emit('reader-status-update', {
                readerId: socket.userId,
                isOnline: false,
                timestamp: new Date().toISOString()
              });
            }
          }
          
          // Clean up session if user was in one
          if (socket.sessionId) {
            await this.cleanupSession(socket.sessionId, socket);
          }

        } catch (error) {
          console.error('WebRTC disconnect cleanup error:', error);
        }
      });
    });
  }

  async cleanupSession(sessionId, socket) {
    try {
      const sessionData = this.activeSessions.get(sessionId);
      
      if (sessionData) {
        sessionData.participants.delete(socket.id);
        
        // If no participants left, remove session
        if (sessionData.participants.size === 0) {
          this.activeSessions.delete(sessionId);
          console.log(`WebRTC: Session ${sessionId} cleaned up`);
        } else {
          // Notify remaining participants
          socket.to(sessionId).emit('participant-left', {
            userId: socket.userId,
            remainingParticipants: sessionData.participants.size,
            timestamp: new Date().toISOString()
          });
        }
      }
      
      // Leave the socket room
      socket.leave(sessionId);
      
    } catch (error) {
      console.error('WebRTC cleanup session error:', error);
    }
  }

  // Notify reader of new session request
  notifyReaderOfSessionRequest(readerId, sessionRequest) {
    const readerSocketId = this.userSockets.get(readerId);
    
    if (readerSocketId) {
      this.io.to(readerSocketId).emit('new-session-request', {
        ...sessionRequest,
        timestamp: new Date().toISOString()
      });
      console.log(`WebRTC: Notified reader ${readerId} of new session request`);
      return true;
    }
    
    console.log(`WebRTC: Reader ${readerId} not connected for session request notification`);
    return false;
  }

  // Notify client of session acceptance
  notifyClientOfSessionAcceptance(clientId, sessionData) {
    const clientSocketId = this.userSockets.get(clientId);
    
    if (clientSocketId) {
      this.io.to(clientSocketId).emit('session-accepted', {
        ...sessionData,
        timestamp: new Date().toISOString()
      });
      console.log(`WebRTC: Notified client ${clientId} of session acceptance`);
      return true;
    }
    
    console.log(`WebRTC: Client ${clientId} not connected for session acceptance notification`);
    return false;
  }

  // Force end session (for billing issues, etc.)
  forceEndSession(sessionId, reason = 'system_ended') {
    const sessionData = this.activeSessions.get(sessionId);
    
    if (sessionData) {
      this.io.to(sessionId).emit('session-force-ended', {
        sessionId,
        reason,
        message: this.getEndReasonMessage(reason),
        timestamp: new Date().toISOString()
      });
      
      // Clean up
      this.activeSessions.delete(sessionId);
      console.log(`WebRTC: Force ended session ${sessionId} - ${reason}`);
    }
  }

  getEndReasonMessage(reason) {
    const messages = {
      'insufficient_balance': 'Session ended due to insufficient balance',
      'reader_offline': 'Session ended because reader went offline',
      'system_maintenance': 'Session ended for system maintenance',
      'violation': 'Session ended due to policy violation',
      'technical_error': 'Session ended due to technical error',
      'timeout': 'Session ended due to inactivity timeout'
    };
    
    return messages[reason] || 'Session ended';
  }

  // Get active session count
  getActiveSessionCount() {
    return this.activeSessions.size;
  }

  // Get connected user count
  getConnectedUserCount() {
    return this.userSockets.size;
  }

  // Get session participants
  getSessionParticipants(sessionId) {
    const sessionData = this.activeSessions.get(sessionId);
    return sessionData ? Array.from(sessionData.participants) : [];
  }

  // Get online readers
  getOnlineReaders() {
    const onlineReaders = [];
    for (const [userId, socketId] of this.userSockets.entries()) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket && socket.userRole === 'READER') {
        onlineReaders.push(userId);
      }
    }
    return onlineReaders;
  }

  // Check if user is connected
  isUserConnected(userId) {
    return this.userSockets.has(userId);
  }
}

module.exports = WebRTCSignaling;