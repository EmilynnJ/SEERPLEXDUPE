import axios from 'axios';

// Production API configuration for Netlify
const API_BASE_URL = '/.netlify/functions/api';

// Create axios instance with base configuration
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle errors
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      // Token expired or invalid
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth API calls
export const authAPI = {
  login: (credentials) => api.post('/auth/login', credentials),
  signup: (userData) => api.post('/auth/signup', userData),
  logout: () => api.post('/auth/logout'),
  getMe: () => api.get('/auth/me'),
  refreshToken: () => api.post('/auth/refresh'),
  forgotPassword: (email) => api.post('/auth/forgot-password', { email })
};

// User API calls
export const userAPI = {
  getReaders: (params) => api.get('/users/readers', { params }),
  getReader: (readerId) => api.get(`/users/readers/${readerId}`),
  updateProfile: (data) => api.patch('/users/profile', data),
  updateReaderRates: (rates) => api.patch('/users/reader/rates', { rates }),
  updateReaderStatus: (isOnline) => api.patch('/users/reader/status', { isOnline }),
  getEarnings: (period) => api.get('/users/reader/earnings', { params: { period } }),
  getStats: () => api.get('/users/stats')
};

// Session API calls
export const sessionAPI = {
  requestSession: (data) => api.post('/sessions/request', data),
  acceptSession: (sessionId) => api.post(`/sessions/${sessionId}/accept`),
  declineSession: (sessionId, reason) => api.post(`/sessions/${sessionId}/decline`, { reason }),
  endSession: (sessionId, data) => api.post(`/sessions/${sessionId}/end`, data),
  chargeSession: (data) => api.post('/sessions/charge', data),
  getHistory: (params) => api.get('/sessions/history', { params }),
  getActiveSession: () => api.get('/sessions/active')
};

// Booking API calls
export const bookingAPI = {
  createBooking: (data) => api.post('/bookings', data),
  getBookings: (params) => api.get('/bookings', { params }),
  confirmBooking: (bookingId) => api.patch(`/bookings/${bookingId}/confirm`),
  cancelBooking: (bookingId, reason) => api.patch(`/bookings/${bookingId}/cancel`, { reason })
};

// Stripe API calls
export const stripeAPI = {
  createPaymentIntent: (amount) => api.post('/stripe/create-payment-intent', { amount }),
  confirmPayment: (paymentIntentId) => api.post('/stripe/confirm-payment', { paymentIntentId }),
  createConnectAccount: () => api.post('/stripe/create-connect-account'),
  getConnectAccountStatus: () => api.get('/stripe/connect-account-status'),
  requestPayout: () => api.post('/stripe/request-payout'),
  getPaymentMethods: () => api.get('/stripe/payment-methods')
};

// Message API calls
export const messageAPI = {
  sendMessage: (data) => api.post('/messages', data),
  getMessages: (params) => api.get('/messages', { params }),
  getConversations: (params) => api.get('/messages/conversations', { params }),
  markAsRead: (messageId) => api.patch(`/messages/${messageId}/read`),
  editMessage: (messageId, content) => api.patch(`/messages/${messageId}`, { content }),
  deleteMessage: (messageId) => api.delete(`/messages/${messageId}`),
  addReaction: (messageId, emoji) => api.post(`/messages/${messageId}/reaction`, { emoji }),
  removeReaction: (messageId) => api.delete(`/messages/${messageId}/reaction`)
};

// Admin API calls
export const adminAPI = {
  getReaders: (params) => api.get('/admin/readers', { params }),
  createReader: (data) => api.post('/admin/readers', data),
  updateReader: (readerId, data) => api.patch(`/admin/readers/${readerId}`, data),
  deleteReader: (readerId) => api.delete(`/admin/readers/${readerId}`),
  getSessions: (params) => api.get('/admin/sessions', { params }),
  getUsers: (params) => api.get('/admin/users', { params }),
  getStats: (params) => api.get('/admin/stats', { params }),
  getRevenue: (params) => api.get('/admin/revenue', { params }),
  processPayouts: () => api.post('/admin/payouts/process'),
  updateUser: (userId, data) => api.patch(`/admin/users/${userId}`, data)
};

export default api;