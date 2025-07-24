import React, { useState, useEffect } from 'react';
import { useUser } from '@clerk/clerk-react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { CalendarIcon, ClockIcon, UserIcon, CreditCardIcon, CheckCircleIcon } from '@heroicons/react/24/outline';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

const serviceTypes = [
  { id: 'tarot', name: 'Tarot Reading', duration: 30, price: 75, description: 'Insightful card reading to guide your path' },
  { id: 'psychic', name: 'Psychic Reading', duration: 45, price: 100, description: 'Connect with spiritual guidance and intuition' },
  { id: 'astrology', name: 'Astrology Reading', duration: 60, price: 125, description: 'Discover your cosmic blueprint and future' },
  { id: 'mediumship', name: 'Mediumship', duration: 45, price: 150, description: 'Connect with loved ones who have passed' }
];

const timeSlots = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '12:30', '13:00', '13:30', '14:00', '14:30',
  '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
  '18:00', '18:30', '19:00', '19:30', '20:00', '20:30'
];

function PaymentForm({ bookingData, onSuccess, onError }) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setMessage('');

    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/booking-success`,
        },
        redirect: 'if_required'
      });

      if (error) {
        setMessage(error.message);
        onError(error);
      } else {
        onSuccess();
      }
    } catch (err) {
      setMessage('An unexpected error occurred.');
      onError(err);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-gray-50 p-4 rounded-lg">
        <h3 className="font-semibold text-gray-900 mb-2">Booking Summary</h3>
        <div className="space-y-2 text-sm text-gray-600">
          <div className="flex justify-between">
            <span>Reader:</span>
            <span className="font-medium">{bookingData.reader?.name}</span>
          </div>
          <div className="flex justify-between">
            <span>Service:</span>
            <span className="font-medium">{bookingData.serviceType?.name}</span>
          </div>
          <div className="flex justify-between">
            <span>Date & Time:</span>
            <span className="font-medium">{bookingData.date} at {bookingData.timeSlot}</span>
          </div>
          <div className="flex justify-between">
            <span>Duration:</span>
            <span className="font-medium">{bookingData.serviceType?.duration} minutes</span>
          </div>
          <div className="flex justify-between font-semibold text-gray-900 pt-2 border-t">
            <span>Total:</span>
            <span>${bookingData.serviceType?.price}</span>
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Payment Information
        </label>
        <PaymentElement />
      </div>

      {message && (
        <div className="text-red-600 text-sm bg-red-50 p-3 rounded-md">
          {message}
        </div>
      )}

      <button
        type="submit"
        disabled={!stripe || !elements || isProcessing}
        className="w-full bg-indigo-600 text-white py-3 px-4 rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
      >
        {isProcessing ? (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
            Processing...
          </>
        ) : (
          <>
            <CreditCardIcon className="h-5 w-5 mr-2" />
            Complete Booking (${bookingData.serviceType?.price})
          </>
        )}
      </button>
    </form>
  );
}

export default function Booking() {
  const { user } = useUser();
  const [currentStep, setCurrentStep] = useState(1);
  const [readers, setReaders] = useState([]);
  const [selectedReader, setSelectedReader] = useState(null);
  const [selectedServiceType, setSelectedServiceType] = useState(null);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedTimeSlot, setSelectedTimeSlot] = useState('');
  const [availableSlots, setAvailableSlots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [clientSecret, setClientSecret] = useState('');
  const [bookingComplete, setBookingComplete] = useState(false);

  // Fetch readers on component mount
  useEffect(() => {
    fetchReaders();
  }, []);

  // Fetch available time slots when reader and date are selected
  useEffect(() => {
    if (selectedReader && selectedDate) {
      fetchAvailableSlots();
    }
  }, [selectedReader, selectedDate]);

  const fetchReaders = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/users/readers');
      const data = await response.json();
      setReaders(data.readers || []);
    } catch (error) {
      console.error('Error fetching readers:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchAvailableSlots = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/bookings/availability?readerId=${selectedReader.id}&date=${selectedDate}`);
      const data = await response.json();
      setAvailableSlots(data.availableSlots || timeSlots);
    } catch (error) {
      console.error('Error fetching available slots:', error);
      setAvailableSlots(timeSlots);
    } finally {
      setLoading(false);
    }
  };

  const createPaymentIntent = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/stripe/create-payment-intent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: selectedServiceType.price * 100, // Convert to cents
          readerId: selectedReader.id,
          serviceType: selectedServiceType.id,
          date: selectedDate,
          timeSlot: selectedTimeSlot,
        }),
      });
      const data = await response.json();
      setClientSecret(data.clientSecret);
    } catch (error) {
      console.error('Error creating payment intent:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleReaderSelect = (reader) => {
    setSelectedReader(reader);
    setCurrentStep(2);
  };

  const handleServiceTypeSelect = (serviceType) => {
    setSelectedServiceType(serviceType);
    setCurrentStep(3);
  };

  const handleDateTimeSelect = () => {
    if (selectedDate && selectedTimeSlot) {
      createPaymentIntent();
      setCurrentStep(4);
    }
  };

  const handlePaymentSuccess = async () => {
    try {
      // Create the booking record
      const response = await fetch('/api/bookings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          readerId: selectedReader.id,
          serviceType: selectedServiceType.id,
          date: selectedDate,
          timeSlot: selectedTimeSlot,
          amount: selectedServiceType.price,
        }),
      });

      if (response.ok) {
        setBookingComplete(true);
        setCurrentStep(5);
      }
    } catch (error) {
      console.error('Error creating booking:', error);
    }
  };

  const handlePaymentError = (error) => {
    console.error('Payment error:', error);
  };

  const getMinDate = () => {
    const today = new Date();
    return today.toISOString().split('T')[0];
  };

  const getMaxDate = () => {
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 30); // Allow booking up to 30 days in advance
    return maxDate.toISOString().split('T')[0];
  };

  if (bookingComplete) {
    return (
      <div className="min-h-screen bg-gray-50 py-12">
        <div className="max-w-md mx-auto bg-white rounded-lg shadow-md p-8 text-center">
          <CheckCircleIcon className="h-16 w-16 text-green-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Booking Confirmed!</h2>
          <p className="text-gray-600 mb-6">
            Your reading with {selectedReader.name} has been scheduled for {selectedDate} at {selectedTimeSlot}.
          </p>
          <div className="space-y-3">
            <button
              onClick={() => window.location.href = '/dashboard'}
              className="w-full bg-indigo-600 text-white py-2 px-4 rounded-md hover:bg-indigo-700"
            >
              Go to Dashboard
            </button>
            <button
              onClick={() => window.location.reload()}
              className="w-full bg-gray-200 text-gray-800 py-2 px-4 rounded-md hover:bg-gray-300"
            >
              Book Another Reading
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-center">
            {[1, 2, 3, 4].map((step) => (
              <div key={step} className="flex items-center">
                <div
                  className={`flex items-center justify-center w-8 h-8 rounded-full ${
                    currentStep >= step
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-300 text-gray-600'
                  }`}
                >
                  {step}
                </div>
                {step < 4 && (
                  <div
                    className={`w-16 h-1 ${
                      currentStep > step ? 'bg-indigo-600' : 'bg-gray-300'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-center mt-2">
            <div className="text-sm text-gray-600 text-center">
              {currentStep === 1 && 'Choose Reader'}
              {currentStep === 2 && 'Select Service'}
              {currentStep === 3 && 'Pick Date & Time'}
              {currentStep === 4 && 'Payment'}
            </div>
          </div>
        </div>

        {/* Step 1: Reader Selection */}
        {currentStep === 1 && (
          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center">
              <UserIcon className="h-6 w-6 mr-2" />
              Choose Your Reader
            </h2>
            {loading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {readers.map((reader) => (
                  <div
                    key={reader.id}
                    className="border rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => handleReaderSelect(reader)}
                  >
                    <div className="flex flex-col items-center text-center">
                      <img
                        src={reader.profileImage || '/default-avatar.png'}
                        alt={reader.name}
                        className="w-20 h-20 rounded-full mb-3 object-cover"
                      />
                      <h3 className="font-semibold text-gray-900">{reader.name}</h3>
                      <p className="text-sm text-gray-600 mb-2">{reader.specialties?.join(', ')}</p>
                      <div className="flex items-center mb-2">
                        <span className="text-yellow-400">★</span>
                        <span className="text-sm text-gray-600 ml-1">
                          {reader.rating || '5.0'} ({reader.reviewCount || 0} reviews)
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mb-3">{reader.bio}</p>
                      <button className="bg-indigo-600 text-white px-4 py-2 rounded-md hover:bg-indigo-700 text-sm">
                        Select Reader
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Service Type Selection */}
        {currentStep === 2 && (
          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">
              Select Service Type
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {serviceTypes.map((service) => (
                <div
                  key={service.id}
                  className={`border rounded-lg p-4 cursor-pointer transition-all ${
                    selectedServiceType?.id === service.id
                      ? 'border-indigo-600 bg-indigo-50'
                      : 'border-gray-300 hover:border-gray-400'
                  }`}
                  onClick={() => handleServiceTypeSelect(service)}
                >
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="font-semibold text-gray-900">{service.name}</h3>
                    <span className="text-lg font-bold text-indigo-600">${service.price}</span>
                  </div>
                  <p className="text-sm text-gray-600 mb-2">{service.description}</p>
                  <p className="text-xs text-gray-500">{service.duration} minutes</p>
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-between">
              <button
                onClick={() => setCurrentStep(1)}
                className="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Date and Time Selection */}
        {currentStep === 3 && (
          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center">
              <CalendarIcon className="h-6 w-6 mr-2" />
              Choose Date & Time
            </h2>
            
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select Date
                </label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  min={getMinDate()}
                  max={getMaxDate()}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Available Time Slots
                </label>
                {selectedDate ? (
                  loading ? (
                    <div className="flex justify-center py-4">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600"></div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                      {availableSlots.map((slot) => (
                        <button
                          key={slot}
                          onClick={() => setSelectedTimeSlot(slot)}
                          className={`p-2 text-sm rounded-md border ${
                            selectedTimeSlot === slot
                              ? 'bg-indigo-600 text-white border-indigo-600'
                              : 'bg-white text-gray-700 border-gray-300 hover:border-indigo-300'
                          }`}
                        >
                          {slot}
                        </button>
                      ))}
                    </div>
                  )
                ) : (
                  <p className="text-gray-500 text-sm">Please select a date first</p>
                )}
              </div>
            </div>

            <div className="mt-6 flex justify-between">
              <button
                onClick={() => setCurrentStep(2)}
                className="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300"
              >
                Back
              </button>
              <button
                onClick={handleDateTimeSelect}
                disabled={!selectedDate || !selectedTimeSlot}
                className="bg-indigo-600 text-white px-4 py-2 rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue to Payment
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Payment */}
        {currentStep === 4 && clientSecret && (
          <div className="bg-white rounded-lg shadow-md p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center">
              <CreditCardIcon className="h-6 w-6 mr-2" />
              Complete Your Booking
            </h2>
            
            <Elements
              stripe={stripePromise}
              options={{
                clientSecret,
                appearance: {
                  theme: 'stripe',
                },
              }}
            >
              <PaymentForm
                bookingData={{
                  reader: selectedReader,
                  serviceType: selectedServiceType,
                  date: selectedDate,
                  timeSlot: selectedTimeSlot,
                }}
                onSuccess={handlePaymentSuccess}
                onError={handlePaymentError}
              />
            </Elements>

            <div className="mt-6">
              <button
                onClick={() => setCurrentStep(3)}
                className="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}