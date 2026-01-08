// utils/presenceManager.js - IN-MEMORY PRESENCE TRACKING
// NO DATABASE STORAGE - Session-based only

/**
 * Presence Manager
 * Tracks user online/offline status in memory
 * 
 * Features:
 * - In-memory Map storage (no DB)
 * - User online/offline tracking
 * - Last seen timestamps
 * - Socket ID mapping
 * - Cleanup for disconnected users
 */

class PresenceManager {
  constructor() {
    // userId -> { socketId, status, lastSeen, connectedAt }
    this.userPresence = new Map();
    
    // socketId -> userId (reverse lookup)
    this.socketToUser = new Map();
    
    // Track multiple sockets per user (mobile + web)
    // userId -> Set of socketIds
    this.userSockets = new Map();
  }
  
  /**
   * Mark user as online
   */
  setUserOnline(userId, socketId, io) {
    const now = new Date();
    
    // Add to userSockets set
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId).add(socketId);
    
    // Update presence
    this.userPresence.set(userId, {
      socketId,
      status: 'ONLINE',
      lastSeen: now,
      connectedAt: now
    });
    
    // Store reverse lookup
    this.socketToUser.set(socketId, userId);
    
    console.log(`🟢 ${userId} is ONLINE (socket: ${socketId})`);
    
    // ✅ Broadcast to all connected clients
    if (io) {
      io.emit('user-online', {
        userId,
        timestamp: now.toISOString()
      });
    }
    
    return {
      userId,
      status: 'ONLINE',
      socketId,
      timestamp: now
    };
  }
  
  /**
   * Mark user as offline
   */
  setUserOffline(userId, socketId, io) {
    const now = new Date();
    
    // Remove socket from user's socket set
    if (this.userSockets.has(userId)) {
      this.userSockets.get(userId).delete(socketId);
      
      // If user has other active sockets, keep them online
      if (this.userSockets.get(userId).size > 0) {
        console.log(`🟡 ${userId} still has ${this.userSockets.get(userId).size} active connections`);
        return {
          userId,
          status: 'ONLINE', // Still online on other devices
          timestamp: now
        };
      }
      
      // Remove empty set
      this.userSockets.delete(userId);
    }
    
    // Update presence to offline
    const presence = this.userPresence.get(userId);
    
    if (presence) {
      presence.status = 'OFFLINE';
      presence.lastSeen = now;
      this.userPresence.set(userId, presence);
    }
    
    // Remove reverse lookup
    this.socketToUser.delete(socketId);
    
    console.log(`⚫ ${userId} is OFFLINE (socket: ${socketId})`);
    
    // ✅ Broadcast to all connected clients
    if (io) {
      io.emit('user-offline', {
        userId,
        lastSeen: now.toISOString(),
        timestamp: now.toISOString()
      });
    }
    
    return {
      userId,
      status: 'OFFLINE',
      lastSeen: now,
      timestamp: now
    };
  }
  
  /**
   * Check if user is online
   */
  isUserOnline(userId) {
    const presence = this.userPresence.get(userId);
    return presence?.status === 'ONLINE';
  }
  
  /**
   * Get user's last seen time
   */
  getUserLastSeen(userId) {
    const presence = this.userPresence.get(userId);
    return presence?.lastSeen || null;
  }
  
  /**
   * Get user presence info
   */
  getUserPresence(userId) {
    const presence = this.userPresence.get(userId);
    
    if (!presence) {
      return {
        userId,
        status: 'OFFLINE',
        lastSeen: null,
        isOnline: false
      };
    }
    
    return {
      userId,
      status: presence.status,
      lastSeen: presence.lastSeen,
      connectedAt: presence.connectedAt,
      socketId: presence.socketId,
      isOnline: presence.status === 'ONLINE'
    };
  }
  
  /**
   * Get user by socket ID
   */
  getUserBySocket(socketId) {
    return this.socketToUser.get(socketId) || null;
  }
  
  /**
   * Get all online users
   */
  getOnlineUsers() {
    const online = [];
    
    for (const [userId, presence] of this.userPresence.entries()) {
      if (presence.status === 'ONLINE') {
        online.push({
          userId,
          socketId: presence.socketId,
          connectedAt: presence.connectedAt
        });
      }
    }
    
    return online;
  }
  
  /**
   * Get online count
   */
  getOnlineCount() {
    let count = 0;
    
    for (const presence of this.userPresence.values()) {
      if (presence.status === 'ONLINE') {
        count++;
      }
    }
    
    return count;
  }
  
  /**
   * Get presence statistics
   */
  getStats() {
    const totalUsers = this.userPresence.size;
    const onlineUsers = this.getOnlineCount();
    const offlineUsers = totalUsers - onlineUsers;
    const totalSockets = this.socketToUser.size;
    
    return {
      totalUsers,
      onlineUsers,
      offlineUsers,
      totalSockets,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Check if users are in same chat and online
   */
  areUsersOnlineTogether(userId1, userId2) {
    return this.isUserOnline(userId1) && this.isUserOnline(userId2);
  }
  
  /**
   * Get formatted "last seen" text
   */
  getLastSeenText(userId) {
    const presence = this.userPresence.get(userId);
    
    if (!presence) {
      return 'Last seen: Unknown';
    }
    
    if (presence.status === 'ONLINE') {
      return 'Online';
    }
    
    if (!presence.lastSeen) {
      return 'Last seen: Unknown';
    }
    
    const now = new Date();
    const lastSeen = new Date(presence.lastSeen);
    const diffMs = now - lastSeen;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) {
      return 'Last seen: Just now';
    } else if (diffMins < 60) {
      return `Last seen: ${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
    } else if (diffHours < 24) {
      return `Last seen: ${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
      return `Last seen: ${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } else {
      return `Last seen: ${lastSeen.toLocaleDateString()}`;
    }
  }
  
  /**
   * Cleanup stale presence (optional, for memory management)
   */
  cleanupStalePresence(maxAgeHours = 24) {
    const now = new Date();
    const maxAge = maxAgeHours * 60 * 60 * 1000;
    
    let cleaned = 0;
    
    for (const [userId, presence] of this.userPresence.entries()) {
      if (presence.status === 'OFFLINE' && presence.lastSeen) {
        const age = now - new Date(presence.lastSeen);
        
        if (age > maxAge) {
          this.userPresence.delete(userId);
          cleaned++;
        }
      }
    }
    
    console.log(`🧹 Cleaned up ${cleaned} stale presence records`);
    
    return cleaned;
  }
  
  /**
   * Remove user completely
   */
  removeUser(userId) {
    this.userPresence.delete(userId);
    this.userSockets.delete(userId);
    
    // Find and remove all sockets for this user
    for (const [socketId, uid] of this.socketToUser.entries()) {
      if (uid === userId) {
        this.socketToUser.delete(socketId);
      }
    }
  }
  
  /**
   * Clear all presence data
   */
  clear() {
    this.userPresence.clear();
    this.socketToUser.clear();
    this.userSockets.clear();
    console.log('🧹 Cleared all presence data');
  }
  
  /**
   * Export presence data (for debugging)
   */
  export() {
    const data = {
      users: Array.from(this.userPresence.entries()).map(([userId, presence]) => ({
        userId,
        ...presence,
        sockets: Array.from(this.userSockets.get(userId) || [])
      })),
      stats: this.getStats()
    };
    
    return data;
  }
}

// Create singleton instance
const presenceManager = new PresenceManager();

// Auto-cleanup every 6 hours
setInterval(() => {
  presenceManager.cleanupStalePresence(24);
}, 6 * 60 * 60 * 1000);

/**
 * Helper function to broadcast presence updates to specific chat rooms
 */
const broadcastPresenceToChatRooms = (io, userId, status, chatIds) => {
  const presence = presenceManager.getUserPresence(userId);
  
  chatIds.forEach(chatId => {
    io.to(chatId).emit('user-presence-update', {
      userId,
      status,
      lastSeen: presence.lastSeen?.toISOString() || null,
      chatId
    });
  });
};

/**
 * Get presence for multiple users (bulk query)
 */
const getBulkPresence = (userIds) => {
  return userIds.map(userId => presenceManager.getUserPresence(userId));
};

module.exports = {
  presenceManager,
  broadcastPresenceToChatRooms,
  getBulkPresence
};
