import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const ReaderCard = ({ reader, isOnline = false }) => {
  const { user } = useAuth();

  const formatRating = (rating) => {
    return rating ? rating.toFixed(1) : '0.0';
  };

  const renderStars = (rating) => {
    const stars = [];
    const fullStars = Math.floor(rating || 0);
    const hasHalfStar = (rating || 0) % 1 >= 0.5;

    for (let i = 0; i < 5; i++) {
      if (i < fullStars) {
        stars.push(<span key={i} className="text-mystical-gold">★</span>);
      } else if (i === fullStars && hasHalfStar) {
        stars.push(<span key={i} className="text-mystical-gold">☆</span>);
      } else {
        stars.push(<span key={i} className="text-gray-400">☆</span>);
      }
    }
    return stars;
  };

  return (
    <div className="card-mystical hover:transform hover:scale-105 transition-all duration-300">
      {/* Reader Avatar */}
      <div className="relative mb-4">
        <img
          src={reader.avatar || '/default-avatar.png'}
          alt={reader.name || 'Reader'}
          className="w-24 h-24 rounded-full mx-auto object-cover border-4 border-mystical-pink"
        />
        {/* Online Status */}
        <div className={`absolute -top-1 -right-1 w-6 h-6 rounded-full border-2 border-white ${
          isOnline ? 'bg-green-500' : 'bg-gray-500'
        }`}></div>
      </div>

      {/* Reader Info */}
      <div className="text-center mb-4">
        <h3 className="font-alex-brush text-2xl text-mystical-pink mb-2">
          {reader.name || 'Anonymous Reader'}
        </h3>
        
        {/* Rating */}
        <div className="flex items-center justify-center mb-2">
          <div className="flex mr-2">
            {renderStars(reader.rating)}
          </div>
          <span className="text-white text-sm">
            {formatRating(reader.rating)} ({reader.totalReviews || 0})
          </span>
        </div>

        {/* Specialties */}
        {reader.specialties && reader.specialties.length > 0 && (
          <div className="mb-3">
            <div className="flex flex-wrap justify-center gap-1">
              {reader.specialties.slice(0, 3).map((specialty, index) => (
                <span
                  key={index}
                  className="px-2 py-1 bg-mystical-pink bg-opacity-20 text-mystical-pink text-xs rounded-full"
                >
                  {specialty}
                </span>
              ))}
              {reader.specialties.length > 3 && (
                <span className="px-2 py-1 bg-mystical-pink bg-opacity-20 text-mystical-pink text-xs rounded-full">
                  +{reader.specialties.length - 3} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Bio Preview */}
        {reader.bio && (
          <p className="text-white text-sm mb-4 line-clamp-3">
            {reader.bio.length > 100 ? `${reader.bio.substring(0, 100)}...` : reader.bio}
          </p>
        )}
      </div>

      {/* Rates */}
      <div className="mb-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-mystical-gold text-sm font-semibold">Video</div>
            <div className="text-white text-xs">${reader.videoRate || '3.99'}/min</div>
          </div>
          <div>
            <div className="text-mystical-gold text-sm font-semibold">Audio</div>
            <div className="text-white text-xs">${reader.audioRate || '2.99'}/min</div>
          </div>
          <div>
            <div className="text-mystical-gold text-sm font-semibold">Chat</div>
            <div className="text-white text-xs">${reader.chatRate || '1.99'}/min</div>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="space-y-2">
        {user ? (
          <>
            {isOnline ? (
              <div className="grid grid-cols-3 gap-1">
                <Link
                  to={`/reading/video-${reader.id}`}
                  className="bg-mystical-pink hover:bg-pink-600 text-white text-xs py-2 px-2 rounded transition-colors text-center"
                >
                  Video
                </Link>
                <Link
                  to={`/reading/audio-${reader.id}`}
                  className="bg-mystical-pink hover:bg-pink-600 text-white text-xs py-2 px-2 rounded transition-colors text-center"
                >
                  Audio
                </Link>
                <Link
                  to={`/reading/chat-${reader.id}`}
                  className="bg-mystical-pink hover:bg-pink-600 text-white text-xs py-2 px-2 rounded transition-colors text-center"
                >
                  Chat
                </Link>
              </div>
            ) : (
              <Link
                to={`/booking/${reader.id}`}
                className="block w-full bg-mystical-gold hover:bg-yellow-500 text-black text-sm py-2 px-4 rounded transition-colors text-center font-semibold"
              >
                Schedule Reading
              </Link>
            )}
            <Link
              to={`/readers/${reader.id}`}
              className="block w-full border border-mystical-pink text-mystical-pink hover:bg-mystical-pink hover:text-white text-sm py-2 px-4 rounded transition-colors text-center"
            >
              View Profile
            </Link>
          </>
        ) : (
          <Link
            to="/login"
            className="block w-full btn-mystical text-sm py-2 px-4 text-center"
          >
            Sign In to Connect
          </Link>
        )}
      </div>

      {/* Online Status Text */}
      <div className="mt-3 text-center">
        <span className={`text-xs font-semibold ${
          isOnline ? 'text-green-400' : 'text-gray-400'
        }`}>
          {isOnline ? '🟢 Online Now' : '⚫ Offline'}
        </span>
      </div>
    </div>
  );
};

export default ReaderCard;