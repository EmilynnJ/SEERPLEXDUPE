import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { sessionAPI } from '../utils/api';

export const useWebRTC = (sessionId, userRole, readerRate, userId) => {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [messages, setMessages] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [sessionTime, setSessionTime] = useState(0);
  const [balance, setBalance] = useState(0);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  
  const socketRef = useRef();
  const peerConnectionRef = useRef();
  const dataChannelRef = useRef();
  const billingIntervalRef = useRef();
  const sessionTimerRef = useRef();

  useEffect(() => {
    if (sessionId && userId) {
      initializeWebRTC();
    }
    return cleanup;
  }, [sessionId, userId]);

  const initializeWebRTC = async () => {
    try {
      // Initialize Socket.IO for production Netlify
      const socketUrl = window.location.origin;
      socketRef.current = io(socketUrl, {
        path: '/.netlify/functions/websocket',
        transports: ['websocket', 'polling']
      });
      
      // Register user with socket
      socketRef.current.emit('register-user', { 
        userId, 
        token: localStorage.getItem('token') 
      });
      
      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({
        video: userRole === 'client' || sessionId.includes('video'),
        audio: true
      });
      setLocalStream(stream);
      
      // Create peer connection with STUN servers
      peerConnectionRef.current = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' }
        ]
      });
      
      // Add local stream tracks
      stream.getTracks().forEach(track => {
        peerConnectionRef.current.addTrack(track, stream);
      });
      
      // Handle remote stream
      peerConnectionRef.current.ontrack = (event) => {
        console.log('Received remote stream');
        setRemoteStream(event.streams[0]);
        setConnectionStatus('connected');
      };
      
      // Setup data channel for chat (if needed)
      if (userRole === 'client') {
        dataChannelRef.current = peerConnectionRef.current.createDataChannel('chat');
        setupDataChannel();
      } else {
        peerConnectionRef.current.ondatachannel = (event) => {
          dataChannelRef.current = event.channel;
          setupDataChannel();
        };
      }
      
      // Setup signaling
      setupSignaling();
      
      // Join session room
      socketRef.current.emit('join-session', { sessionId, userId });
      
      // Start session timer
      sessionTimerRef.current = setInterval(() => {
        setSessionTime(prev => prev + 1);
      }, 1000);
      
      // Start billing if client
      if (userRole === 'client' && readerRate) {
        startBilling();
      }
      
    } catch (error) {
      console.error('WebRTC initialization failed:', error);
      setConnectionStatus('failed');
    }
  };

  const setupSignaling = () => {
    const socket = socketRef.current;
    const pc = peerConnectionRef.current;
    
    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-ice-candidate', {
          sessionId,
          candidate: event.candidate
        });
      }
    };
    
    socket.on('webrtc-ice-candidate', async (data) => {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (error) {
        console.error('Error adding ICE candidate:', error);
      }
    });
    
    // Offer/Answer handling
    socket.on('webrtc-offer', async (data) => {
      try {
        await pc.setRemoteDescription(data.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-answer', { sessionId, answer });
      } catch (error) {
        console.error('Error handling offer:', error);
      }
    });
    
    socket.on('webrtc-answer', async (data) => {
      try {
        await pc.setRemoteDescription(data.answer);
      } catch (error) {
        console.error('Error handling answer:', error);
      }
    });
    
    // Session events
    socket.on('session-joined', (data) => {
      console.log('Joined session:', data);
      if (userRole === 'client') {
        initiateCall();
      }
    });
    
    socket.on('user-joined', (data) => {
      console.log('User joined:', data);
      if (userRole === 'reader') {
        initiateCall();
      }
    });
    
    socket.on('session-ended', () => {
      endSession();
    });
    
    socket.on('session-force-ended', (data) => {
      console.log('Session force ended:', data.reason);
      endSession();
    });

    // Message handling
    socket.on('session-message', (data) => {
      setMessages(prev => [...prev, {
        id: data.id,
        text: data.message,
        sender: data.fromUserId === userId ? 'me' : 'other',
        senderName: data.fromUserName,
        timestamp: new Date(data.timestamp)
      }]);
    });
  };

  const setupDataChannel = () => {
    const dc = dataChannelRef.current;
    
    dc.onopen = () => {
      console.log('Data channel opened');
    };
    
    dc.onmessage = (event) => {
      const message = JSON.parse(event.data);
      setMessages(prev => [...prev, message]);
    };
  };

  const initiateCall = async () => {
    try {
      const pc = peerConnectionRef.current;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current.emit('webrtc-offer', { sessionId, offer });
    } catch (error) {
      console.error('Failed to initiate call:', error);
    }
  };

  const startBilling = () => {
    // Charge every minute
    billingIntervalRef.current = setInterval(async () => {
      try {
        const response = await sessionAPI.chargeSession({
          sessionId,
          amount: Math.round(readerRate * 100) // Convert to cents
        });
        
        setBalance(response.data.balance);
        
        if (response.data.sessionEnded) {
          endSession();
        }
      } catch (error) {
        console.error('Billing failed:', error);
        if (error.response?.data?.sessionEnded) {
          endSession();
        }
      }
    }, 60000); // 1 minute
  };

  const sendMessage = (text) => {
    if (socketRef.current) {
      socketRef.current.emit('session-message', {
        sessionId,
        message: text,
        messageType: 'TEXT'
      });
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
        
        // Notify other peer
        socketRef.current?.emit('media-state-change', {
          sessionId,
          mediaType: 'video',
          enabled: videoTrack.enabled
        });
      }
    }
  };

  const toggleAudio = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
        
        // Notify other peer
        socketRef.current?.emit('media-state-change', {
          sessionId,
          mediaType: 'audio',
          enabled: audioTrack.enabled
        });
      }
    }
  };

  const endSession = async () => {
    try {
      // Notify server
      await sessionAPI.endSession(sessionId, {});
      
      // Notify other peer
      socketRef.current?.emit('end-session', { sessionId });
      
      setConnectionStatus('ended');
      cleanup();
    } catch (error) {
      console.error('Failed to end session:', error);
      cleanup();
    }
  };

  const cleanup = () => {
    // Stop local stream
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    
    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    // Disconnect socket
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    
    // Clear intervals
    if (billingIntervalRef.current) {
      clearInterval(billingIntervalRef.current);
      billingIntervalRef.current = null;
    }
    
    if (sessionTimerRef.current) {
      clearInterval(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
    
    setRemoteStream(null);
    setConnectionStatus('disconnected');
  };

  return {
    localStream,
    remoteStream,
    messages,
    connectionStatus,
    sessionTime,
    balance,
    isVideoEnabled,
    isAudioEnabled,
    sendMessage,
    toggleVideo,
    toggleAudio,
    endSession
  };
};