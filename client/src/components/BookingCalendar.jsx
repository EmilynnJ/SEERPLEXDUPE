import React, { useState, useEffect, useMemo } from 'react';
import api from '../utils/api';

const BookingCalendar = ({ readerId, onBookingComplete, onClose }) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [loading, setLoading] = useState(false);
  const [bookingLoading, setBookingLoading] = useState(false);
  const [error, setError] = useState(null);
  const [userTimezone, setUserTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [bookingDetails, setBookingDetails] = useState({
    duration: 30,
    serviceType: 'general',
    notes: ''
  });

  // Service types and durations
  const serviceTypes = [
    { id: 'general', name: 'General Reading', price: 3.99 },
    { id: 'love', name: 'Love & Relationships', price: 4.99 },
    { id: 'career', name: 'Career & Finance', price: 4.99 },
    { id: 'spiritual', name: 'Spiritual Guidance', price: 5.99 }
  ];

  const durations = [15, 30, 45, 60];

  // Fetch reader availability for the current month
  useEffect(() => {
    fetchAvailability();
  }, [currentDate, readerId]);

  const fetchAvailability = async () => {
    if (!readerId) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const startDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const endDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
      
      const response = await api.get(`/api/bookings/availability/${readerId}`, {
        params: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          timezone: userTimezone
        }
      });
      
      setAvailability(response.data.availability || []);
    } catch (err) {
      setError('Failed to load availability. Please try again.');
      console.error('Error fetching availability:', err);
    } finally {
      setLoading(false);
    }
  };

  // Generate calendar days for the current month
  const calendarDays = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDate = new Date(firstDay);
    startDate.setDate(startDate.getDate() - firstDay.getDay());
    
    const days = [];
    const currentDateObj = new Date(startDate);
    
    for (let i = 0; i < 42; i++) {
      const dayAvailability = availability.find(av => 
        new Date(av.date).toDateString() === currentDateObj.toDateString()
      );
      
      days.push({
        date: new Date(currentDateObj),
        isCurrentMonth: currentDateObj.getMonth() === month,
        isToday: currentDateObj.toDateString() === new Date().toDateString(),
        isPast: currentDateObj < new Date().setHours(0, 0, 0, 0),
        hasAvailability: dayAvailability && dayAvailability.slots.length > 0,
        slots: dayAvailability?.slots || []
      });
      
      currentDateObj.setDate(currentDateObj.getDate() + 1);
    }
    
    return days;
  }, [currentDate, availability]);

  // Get available time slots for selected date
  const availableSlots = useMemo(() => {
    if (!selectedDate) return [];
    
    const dayData = calendarDays.find(day => 
      day.date.toDateString() === selectedDate.toDateString()
    );
    
    return dayData?.slots || [];
  }, [selectedDate, calendarDays]);

  // Navigate calendar months
  const navigateMonth = (direction) => {
    setCurrentDate(prev => {
      const newDate = new Date(prev);
      newDate.setMonth(prev.getMonth() + direction);
      return newDate;
    });
    setSelectedDate(null);
    setSelectedTime(null);
  };

  // Handle date selection
  const handleDateSelect = (day) => {
    if (day.isPast || !day.hasAvailability || !day.isCurrentMonth) return;
    
    setSelectedDate(day.date);
    setSelectedTime(null);
  };

  // Handle time slot selection
  const handleTimeSelect = (slot) => {
    setSelectedTime(slot);
  };

  // Calculate total price
  const totalPrice = useMemo(() => {
    const servicePrice = serviceTypes.find(s => s.id === bookingDetails.serviceType)?.price || 0;
    return (servicePrice * bookingDetails.duration).toFixed(2);
  }, [bookingDetails]);

  // Handle booking confirmation
  const handleBookingConfirm = async () => {
    if (!selectedDate || !selectedTime || !readerId) return;
    
    setBookingLoading(true);
    setError(null);
    
    try {
      const bookingData = {
        readerId,
        date: selectedDate.toISOString(),
        startTime: selectedTime.startTime,
        endTime: selectedTime.endTime,
        duration: bookingDetails.duration,
        serviceType: bookingDetails.serviceType,
        notes: bookingDetails.notes,
        timezone: userTimezone,
        totalPrice: parseFloat(totalPrice)
      };
      
      const response = await api.post('/api/bookings', bookingData);
      
      if (response.data.success) {
        onBookingComplete && onBookingComplete(response.data.booking);
        setShowConfirmation(false);
        onClose && onClose();
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create booking. Please try again.');
      console.error('Error creating booking:', err);
    } finally {
      setBookingLoading(false);
    }
  };

  // Format time for display
  const formatTime = (timeString) => {
    return new Date(`2000-01-01T${timeString}`).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: userTimezone
    });
  };

  // Format date for display
  const formatDate = (date) => {
    return date.toLocaleDateString([], {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: userTimezone
    });
  };

  if (showConfirmation) {
    return (
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-md mx-auto">
        <h3 className="text-xl font-semibold mb-4">Confirm Your Booking</h3>
        
        <div className="space-y-3 mb-6">
          <div className="flex justify-between">
            <span className="text-gray-600">Date:</span>
            <span className="font-medium">{formatDate(selectedDate)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Time:</span>
            <span className="font-medium">
              {formatTime(selectedTime.startTime)} - {formatTime(selectedTime.endTime)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Duration:</span>
            <span className="font-medium">{bookingDetails.duration} minutes</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Service:</span>
            <span className="font-medium">
              {serviceTypes.find(s => s.id === bookingDetails.serviceType)?.name}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Timezone:</span>
            <span className="font-medium">{userTimezone}</span>
          </div>
          <div className="flex justify-between text-lg font-semibold border-t pt-2">
            <span>Total:</span>
            <span className="text-purple-600">${totalPrice}</span>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}

        <div className="flex space-x-3">
          <button
            onClick={() => setShowConfirmation(false)}
            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            disabled={bookingLoading}
          >
            Back
          </button>
          <button
            onClick={handleBookingConfirm}
            disabled={bookingLoading}
            className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
          >
            {bookingLoading ? 'Booking...' : 'Confirm Booking'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-xl p-6 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-semibold">Schedule Your Reading</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Calendar Section */}
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-medium">Select Date</h3>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => navigateMonth(-1)}
                className="p-2 hover:bg-gray-100 rounded"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="text-lg font-medium min-w-[200px] text-center">
                {currentDate.toLocaleDateString([], { month: 'long', year: 'numeric' })}
              </span>
              <button
                onClick={() => navigateMonth(1)}
                className="p-2 hover:bg-gray-100 rounded"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1 mb-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
              <div key={day} className="p-2 text-center text-sm font-medium text-gray-500">
                {day}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((day, index) => (
              <button
                key={index}
                onClick={() => handleDateSelect(day)}
                disabled={day.isPast || !day.hasAvailability || !day.isCurrentMonth}
                className={`
                  p-2 text-sm rounded-lg transition-colors relative
                  ${!day.isCurrentMonth ? 'text-gray-300' : ''}
                  ${day.isToday ? 'bg-blue-100 text-blue-600' : ''}
                  ${day.isPast ? 'text-gray-300 cursor-not-allowed' : ''}
                  ${day.hasAvailability && day.isCurrentMonth && !day.isPast 
                    ? 'hover:bg-purple-100 cursor-pointer' 
                    : ''
                  }
                  ${selectedDate?.toDateString() === day.date.toDateString() 
                    ? 'bg-purple-600 text-white' 
                    : ''
                  }
                `}
              >
                {day.date.getDate()}
                {day.hasAvailability && day.isCurrentMonth && !day.isPast && (
                  <div className="absolute bottom-1 left-1/2 transform -translate-x-1/2 w-1 h-1 bg-green-500 rounded-full"></div>
                )}
              </button>
            ))}
          </div>

          <div className="mt-4 text-xs text-gray-500">
            <div className="flex items-center space-x-4">
              <div className="flex items-center">
                <div className="w-2 h-2 bg-green-500 rounded-full mr-1"></div>
                Available
              </div>
              <div className="flex items-center">
                <div className="w-2 h-2 bg-blue-500 rounded-full mr-1"></div>
                Today
              </div>
            </div>
          </div>
        </div>

        {/* Time Slots and Booking Details */}
        <div>
          {selectedDate ? (
            <div>
              <h3 className="text-lg font-medium mb-4">
                Available Times - {formatDate(selectedDate)}
              </h3>
              
              {loading ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto"></div>
                </div>
              ) : availableSlots.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 mb-6">
                  {availableSlots.map((slot, index) => (
                    <button
                      key={index}
                      onClick={() => handleTimeSelect(slot)}
                      className={`
                        p-3 text-sm rounded-lg border transition-colors
                        ${selectedTime === slot
                          ? 'bg-purple-600 text-white border-purple-600'
                          : 'border-gray-200 hover:border-purple-300 hover:bg-purple-50'
                        }
                      `}
                    >
                      {formatTime(slot.startTime)} - {formatTime(slot.endTime)}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">
                  No available time slots for this date.
                </p>
              )}

              {selectedTime && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Service Type
                    </label>
                    <select
                      value={bookingDetails.serviceType}
                      onChange={(e) => setBookingDetails(prev => ({ ...prev, serviceType: e.target.value }))}
                      className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    >
                      {serviceTypes.map(service => (
                        <option key={service.id} value={service.id}>
                          {service.name} - ${service.price}/min
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Duration (minutes)
                    </label>
                    <select
                      value={bookingDetails.duration}
                      onChange={(e) => setBookingDetails(prev => ({ ...prev, duration: parseInt(e.target.value) }))}
                      className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    >
                      {durations.map(duration => (
                        <option key={duration} value={duration}>
                          {duration} minutes
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Notes (Optional)
                    </label>
                    <textarea
                      value={bookingDetails.notes}
                      onChange={(e) => setBookingDetails(prev => ({ ...prev, notes: e.target.value }))}
                      placeholder="Any specific questions or topics you'd like to discuss..."
                      className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      rows={3}
                    />
                  </div>

                  <div className="bg-gray-50 p-4 rounded-lg">
                    <div className="flex justify-between items-center text-lg font-semibold">
                      <span>Total Cost:</span>
                      <span className="text-purple-600">${totalPrice}</span>
                    </div>
                  </div>

                  <button
                    onClick={() => setShowConfirmation(true)}
                    className="w-full bg-purple-600 text-white py-3 px-4 rounded-lg hover:bg-purple-700 transition-colors font-medium"
                  >
                    Continue to Confirmation
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12">
              <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-gray-500">Select a date to view available time slots</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BookingCalendar;