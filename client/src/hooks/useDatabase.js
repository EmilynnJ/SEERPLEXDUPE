import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../utils/api';

// Cache for storing API responses
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Helper function to generate cache keys
const getCacheKey = (endpoint, params = {}) => {
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((result, key) => {
      result[key] = params[key];
      return result;
    }, {});
  return `${endpoint}:${JSON.stringify(sortedParams)}`;
};

// Helper function to check if cache entry is valid
const isCacheValid = (entry) => {
  return entry && Date.now() - entry.timestamp < CACHE_DURATION;
};

export const useDatabase = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortControllerRef = useRef(null);

  // Cleanup function to abort ongoing requests
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Generic API call function with caching and error handling
  const makeRequest = useCallback(async (method, endpoint, data = null, options = {}) => {
    const { useCache = true, skipLoading = false } = options;
    
    // Generate cache key for GET requests
    const cacheKey = method === 'GET' ? getCacheKey(endpoint, data) : null;
    
    // Check cache for GET requests
    if (method === 'GET' && useCache && cacheKey) {
      const cachedEntry = cache.get(cacheKey);
      if (isCacheValid(cachedEntry)) {
        return cachedEntry.data;
      }
    }

    // Abort previous request if exists
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller
    abortControllerRef.current = new AbortController();

    if (!skipLoading) {
      setLoading(true);
    }
    setError(null);

    try {
      const config = {
        method,
        url: endpoint,
        signal: abortControllerRef.current.signal,
        ...options.axiosConfig
      };

      if (method === 'GET' && data) {
        config.params = data;
      } else if (data) {
        config.data = data;
      }

      const response = await api(config);
      const responseData = response.data;

      // Cache GET requests
      if (method === 'GET' && useCache && cacheKey) {
        cache.set(cacheKey, {
          data: responseData,
          timestamp: Date.now()
        });
      }

      return responseData;
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'ERR_CANCELED') {
        // Request was aborted, don't set error
        return null;
      }

      const errorMessage = err.response?.data?.message || err.message || 'An error occurred';
      setError(errorMessage);
      throw new Error(errorMessage);
    } finally {
      if (!skipLoading) {
        setLoading(false);
      }
      abortControllerRef.current = null;
    }
  }, []);

  // User operations
  const users = {
    getProfile: useCallback((userId) => 
      makeRequest('GET', `/api/users/${userId}`), [makeRequest]),
    
    updateProfile: useCallback((userId, data) => 
      makeRequest('PUT', `/api/users/${userId}`, data, { useCache: false }), [makeRequest]),
    
    getReaders: useCallback((filters = {}) => 
      makeRequest('GET', '/api/users/readers', filters), [makeRequest]),
    
    getReaderStats: useCallback((readerId) => 
      makeRequest('GET', `/api/users/${readerId}/stats`), [makeRequest]),
    
    updateAvailability: useCallback((userId, availability) => 
      makeRequest('PUT', `/api/users/${userId}/availability`, { availability }, { useCache: false }), [makeRequest]),
    
    getEarnings: useCallback((userId, period = 'month') => 
      makeRequest('GET', `/api/users/${userId}/earnings`, { period }), [makeRequest])
  };

  // Session operations
  const sessions = {
    create: useCallback((data) => 
      makeRequest('POST', '/api/sessions', data, { useCache: false }), [makeRequest]),
    
    get: useCallback((sessionId) => 
      makeRequest('GET', `/api/sessions/${sessionId}`), [makeRequest]),
    
    update: useCallback((sessionId, data) => 
      makeRequest('PUT', `/api/sessions/${sessionId}`, data, { useCache: false }), [makeRequest]),
    
    accept: useCallback((sessionId) => 
      makeRequest('POST', `/api/sessions/${sessionId}/accept`, null, { useCache: false }), [makeRequest]),
    
    decline: useCallback((sessionId, reason) => 
      makeRequest('POST', `/api/sessions/${sessionId}/decline`, { reason }, { useCache: false }), [makeRequest]),
    
    end: useCallback((sessionId) => 
      makeRequest('POST', `/api/sessions/${sessionId}/end`, null, { useCache: false }), [makeRequest]),
    
    getHistory: useCallback((userId, filters = {}) => 
      makeRequest('GET', `/api/sessions/history/${userId}`, filters), [makeRequest]),
    
    getActive: useCallback((userId) => 
      makeRequest('GET', `/api/sessions/active/${userId}`), [makeRequest])
  };

  // Message operations
  const messages = {
    send: useCallback((data) => 
      makeRequest('POST', '/api/messages', data, { useCache: false }), [makeRequest]),
    
    getConversation: useCallback((conversationId, page = 1, limit = 50) => 
      makeRequest('GET', `/api/messages/conversation/${conversationId}`, { page, limit }), [makeRequest]),
    
    getConversations: useCallback((userId) => 
      makeRequest('GET', `/api/messages/conversations/${userId}`), [makeRequest]),
    
    markAsRead: useCallback((conversationId, userId) => 
      makeRequest('PUT', `/api/messages/conversation/${conversationId}/read`, { userId }, { useCache: false }), [makeRequest]),
    
    getUnreadCount: useCallback((userId) => 
      makeRequest('GET', `/api/messages/unread/${userId}`, null, { useCache: false }), [makeRequest])
  };

  // Transaction operations
  const transactions = {
    create: useCallback((data) => 
      makeRequest('POST', '/api/transactions', data, { useCache: false }), [makeRequest]),
    
    get: useCallback((transactionId) => 
      makeRequest('GET', `/api/transactions/${transactionId}`), [makeRequest]),
    
    getHistory: useCallback((userId, filters = {}) => 
      makeRequest('GET', `/api/transactions/history/${userId}`, filters), [makeRequest]),
    
    getBalance: useCallback((userId) => 
      makeRequest('GET', `/api/transactions/balance/${userId}`, null, { useCache: false }), [makeRequest])
  };

  // Booking operations
  const bookings = {
    create: useCallback((data) => 
      makeRequest('POST', '/api/bookings', data, { useCache: false }), [makeRequest]),
    
    get: useCallback((bookingId) => 
      makeRequest('GET', `/api/bookings/${bookingId}`), [makeRequest]),
    
    update: useCallback((bookingId, data) => 
      makeRequest('PUT', `/api/bookings/${bookingId}`, data, { useCache: false }), [makeRequest]),
    
    cancel: useCallback((bookingId, reason) => 
      makeRequest('DELETE', `/api/bookings/${bookingId}`, { reason }, { useCache: false }), [makeRequest]),
    
    getByUser: useCallback((userId, filters = {}) => 
      makeRequest('GET', `/api/bookings/user/${userId}`, filters), [makeRequest]),
    
    getAvailability: useCallback((readerId, date) => 
      makeRequest('GET', `/api/bookings/availability/${readerId}`, { date }), [makeRequest]),
    
    confirm: useCallback((bookingId) => 
      makeRequest('POST', `/api/bookings/${bookingId}/confirm`, null, { useCache: false }), [makeRequest])
  };

  // Stripe/Payment operations
  const payments = {
    createPaymentIntent: useCallback((amount, currency = 'usd') => 
      makeRequest('POST', '/api/stripe/payment-intent', { amount, currency }, { useCache: false }), [makeRequest]),
    
    confirmPayment: useCallback((paymentIntentId) => 
      makeRequest('POST', `/api/stripe/confirm-payment/${paymentIntentId}`, null, { useCache: false }), [makeRequest]),
    
    addFunds: useCallback((amount, paymentMethodId) => 
      makeRequest('POST', '/api/stripe/add-funds', { amount, paymentMethodId }, { useCache: false }), [makeRequest]),
    
    createConnectAccount: useCallback((data) => 
      makeRequest('POST', '/api/stripe/connect-account', data, { useCache: false }), [makeRequest]),
    
    getConnectAccountStatus: useCallback((userId) => 
      makeRequest('GET', `/api/stripe/connect-account/${userId}`), [makeRequest]),
    
    requestPayout: useCallback((amount) => 
      makeRequest('POST', '/api/stripe/payout', { amount }, { useCache: false }), [makeRequest])
  };

  // Admin operations
  const admin = {
    getUsers: useCallback((filters = {}) => 
      makeRequest('GET', '/api/admin/users', filters), [makeRequest]),
    
    createReader: useCallback((data) => 
      makeRequest('POST', '/api/admin/readers', data, { useCache: false }), [makeRequest]),
    
    updateUser: useCallback((userId, data) => 
      makeRequest('PUT', `/api/admin/users/${userId}`, data, { useCache: false }), [makeRequest]),
    
    getStats: useCallback((period = 'month') => 
      makeRequest('GET', '/api/admin/stats', { period }), [makeRequest]),
    
    getRevenue: useCallback((period = 'month') => 
      makeRequest('GET', '/api/admin/revenue', { period }), [makeRequest]),
    
    getSessions: useCallback((filters = {}) => 
      makeRequest('GET', '/api/admin/sessions', filters), [makeRequest])
  };

  // Cache management
  const cache_utils = {
    clear: useCallback(() => {
      cache.clear();
    }, []),
    
    clearKey: useCallback((endpoint, params = {}) => {
      const key = getCacheKey(endpoint, params);
      cache.delete(key);
    }, []),
    
    invalidateUserData: useCallback((userId) => {
      const keysToDelete = [];
      for (const key of cache.keys()) {
        if (key.includes(`/users/${userId}`) || key.includes(`user/${userId}`)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => cache.delete(key));
    }, []),
    
    invalidateSessionData: useCallback((sessionId) => {
      const keysToDelete = [];
      for (const key of cache.keys()) {
        if (key.includes(`/sessions/${sessionId}`) || key.includes(`session/${sessionId}`)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => cache.delete(key));
    }, [])
  };

  // Utility functions
  const utils = {
    // Retry a failed request
    retry: useCallback(async (requestFn, maxRetries = 3, delay = 1000) => {
      let lastError;
      
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await requestFn();
        } catch (error) {
          lastError = error;
          if (i < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
          }
        }
      }
      
      throw lastError;
    }, []),
    
    // Batch multiple requests
    batch: useCallback(async (requests) => {
      const results = await Promise.allSettled(requests);
      return results.map(result => 
        result.status === 'fulfilled' ? result.value : { error: result.reason.message }
      );
    }, []),
    
    // Check if currently loading
    isLoading: useCallback(() => loading, [loading]),
    
    // Get current error
    getError: useCallback(() => error, [error]),
    
    // Clear current error
    clearError: useCallback(() => setError(null), [])
  };

  return {
    loading,
    error,
    users,
    sessions,
    messages,
    transactions,
    bookings,
    payments,
    admin,
    cache: cache_utils,
    utils
  };
};

export default useDatabase;