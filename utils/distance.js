// ==========================================
// utils/distance.js - HAVERSINE FORMULA
// ==========================================

/**
 * Calculate distance between two coordinates using Haversine formula
 * 
 * @param {Number} lat1 - Latitude of point 1
 * @param {Number} lng1 - Longitude of point 1
 * @param {Number} lat2 - Latitude of point 2
 * @param {Number} lng2 - Longitude of point 2
 * @returns {Number} Distance in kilometers
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in kilometers
  
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return R * c; // Distance in km
}

/**
 * Convert degrees to radians
 */
function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Find nearby users within a radius
 * 
 * @param {Object} currentUser - Current user object with location
 * @param {Array} users - Array of user objects to check
 * @param {Number} radiusKm - Radius in kilometers (default: 50km)
 * @returns {Array} Users within radius, sorted by distance
 */
function findNearbyUsers(currentUser, users, radiusKm = 50) {
  // Validate current user has location
  if (!currentUser.last_known_lat || !currentUser.last_known_lng) {
    return [];
  }

  const nearbyUsers = users
    .filter(user => {
      // Skip users without location
      if (!user.last_known_lat || !user.last_known_lng) {
        return false;
      }

      // Skip users with old location (> 24 hours)
      if (!user.hasRecentLocation || !user.hasRecentLocation()) {
        return false;
      }

      // Calculate distance
      const distance = calculateDistance(
        currentUser.last_known_lat,
        currentUser.last_known_lng,
        user.last_known_lat,
        user.last_known_lng
      );

      // Add distance to user object for sorting
      user.distance = distance;

      return distance <= radiusKm;
    })
    .sort((a, b) => a.distance - b.distance); // Sort by distance (nearest first)

  return nearbyUsers;
}

/**
 * Check if user is within radius of a booking
 * 
 * @param {Object} user - User with location
 * @param {Object} booking - Booking with lat/lng
 * @param {Number} radiusKm - Maximum distance in km
 * @returns {Boolean} True if within radius
 */
function isUserNearBooking(user, booking, radiusKm = 50) {
  if (!user.last_known_lat || !user.last_known_lng) {
    return false;
  }

  if (!booking.lat || !booking.lng) {
    return false;
  }

  const distance = calculateDistance(
    user.last_known_lat,
    user.last_known_lng,
    booking.lat,
    booking.lng
  );

  return distance <= radiusKm;
}

module.exports = {
  calculateDistance,
  findNearbyUsers,
  isUserNearBooking
};
