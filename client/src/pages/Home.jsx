import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Hero from '../components/Hero';
import ReaderCard from '../components/ReaderCard';
import LoadingSpinner from '../components/LoadingSpinner';
import { userAPI } from '../utils/api';

const Home = () => {
  const [featuredReaders, setFeaturedReaders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchFeaturedReaders();
  }, []);

  const fetchFeaturedReaders = async () => {
    try {
      setLoading(true);
      const response = await userAPI.getReaders({
        limit: 6,
        sortBy: 'rating',
        isOnline: true
      });
      setFeaturedReaders(response.data.readers || []);
    } catch (err) {
      console.error('Error fetching readers:', err);
      setError('Failed to load readers');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Hero />
      
      {/* Featured Readers Section */}
      <section className="py-16 px-4">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="font-alex-brush text-4xl md:text-6xl text-mystical-pink mb-4">
              Featured Readers
            </h2>
            <p className="font-playfair text-xl text-white max-w-2xl mx-auto">
              Connect with our most experienced and highly-rated spiritual advisors
            </p>
          </div>

          {loading ? (
            <LoadingSpinner />
          ) : error ? (
            <div className="text-center text-red-400 py-8">
              <p>{error}</p>
              <button 
                onClick={fetchFeaturedReaders}
                className="btn-mystical mt-4"
              >
                Try Again
              </button>
            </div>
          ) : featuredReaders.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {featuredReaders.map((reader) => (
                <ReaderCard 
                  key={reader.id} 
                  reader={reader}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-white text-xl mb-4">No featured readers available</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default Home;