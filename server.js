// Next.js 自定义服务器 + Socket.IO
const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { Server } = require('socket.io');
const {
  attachTVRemoteIO,
  cleanupTVRemoteDevices,
  clearTVRemoteHub,
  registerTVRemoteDevice,
  removeTVRemoteSocket,
  updateTVRemoteDevice,
} = require('./src/lib/tv-remote-hub.js');

function shouldInitSQLite() {
  const isCloudflare = process.env.CF_PAGES === '1' || process.env.BUILD_TARGET === 'cloudflare';
  return process.env.NEXT_PUBLIC_STORAGE_TYPE === 'd1' && !isCloudflare && process.env.MOONTV_LITE !== 'true';
}

function isTVModeEnabled() {
  return process.env.ENABLE_TV_MODE !== 'false';
}

function ensureSQLiteReady() {
  if (!shouldInitSQLite()) {
    return;
  }

  try {
    const { initSQLiteDatabase } = require('./scripts/init-sqlite.js');
    initSQLiteDatabase();
  } catch (error) {
    console.error('❌ Error initializing SQLite database:', error);
    throw error;
  }
}

ensureSQLiteReady();

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// 读取观影室配置的辅助函数
async function getWatchRoomConfig() {
  // 观影室配置现在统一从环境变量读取
  const config = {
    enabled: process.env.WATCH_ROOM_ENABLED === 'true',
    serverType: (process.env.WATCH_ROOM_SERVER_TYPE || 'internal'),
    externalServerUrl: process.env.WATCH_ROOM_EXTERNAL_SERVER_URL,
    externalServerAuth: process.env.WATCH_ROOM_EXTERNAL_SERVER_AUTH,
  };

  console.log(`[WatchRoom] Watch room ${config.enabled ? 'enabled' : 'disabled'} via environment variable.`);
  return config;
}

// 观影室服务器类
class WatchRoomServer {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.members = new Map();
    this.socketToRoom = new Map();
    this.screenHelpers = new Map();
    this.helperToRoom = new Map();
    this.roomDeletionTimers = new Map(); // 房间延迟删除定时器
    this.cleanupInterval = null;
    this.setupEventHandlers();
    this.startCleanupTimer();
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`[WatchRoom] Client connected: ${socket.id}`);

      // 创建房间
      socket.on('room:create', (data, callback) => {
        try {
          const roomId = this.generateRoomId();
          const userId = socket.id;
          const ownerToken = this.generateRoomId(); // 生成房主令牌

          const room = {
            id: roomId,
            name: data.name,
            description: data.description,
            password: data.password,
            isPublic: data.isPublic,
            roomType: data.roomType || 'sync',
            ownerId: userId,
            ownerName: data.userName,
            ownerToken: ownerToken, // 保存房主令牌
            memberCount: 1,
            currentState: null,
            createdAt: Date.now(),
            lastOwnerHeartbeat: Date.now(),
          };

          const member = {
            id: userId,
            name: data.userName,
            isOwner: true,
            lastHeartbeat: Date.now(),
          };

          this.rooms.set(roomId, room);
          this.members.set(roomId, new Map([[userId, member]]));
          this.socketToRoom.set(socket.id, {
            roomId,
            userId,
            userName: data.userName,
            isOwner: true,
          });

          socket.join(roomId);

          console.log(`[WatchRoom] Room created: ${roomId} by ${data.userName}`);
          callback({ success: true, room });
        } catch (error) {
          console.error('[WatchRoom] Error creating room:', error);
          callback({ success: false, error: '创建房间失败' });
        }
      });

      // 加入房间
      socket.on('room:join', (data, callback) => {
        try {
          const room = this.rooms.get(data.roomId);
          if (!room) {
            return callback({ success: false, error: '房间不存在' });
          }

          if (room.password && room.password !== data.password) {
            return callback({ success: false, error: '密码错误' });
          }

          const userId = socket.id;
          let isOwner = false;

          // 检查是否是房主重连（通过 ownerToken 验证）
          if (data.ownerToken && data.ownerToken === room.ownerToken) {
            isOwner = true;
            // 更新房主的 socket.id
            room.ownerId = userId;
            room.lastOwnerHeartbeat = Date.now();
            this.rooms.set(data.roomId, room);
            console.log(`[WatchRoom] Owner ${data.userName} reconnected to room ${data.roomId}`);
          }

          // 取消房间的删除定时器（如果有人重连）
          if (this.roomDeletionTimers.has(data.roomId)) {
            console.log(`[WatchRoom] Cancelling deletion timer for room ${data.roomId}`);
            clearTimeout(this.roomDeletionTimers.get(data.roomId));
            this.roomDeletionTimers.delete(data.roomId);
          }

          const member = {
            id: userId,
            name: data.userName,
            isOwner: isOwner,
            lastHeartbeat: Date.now(),
          };

          const roomMembers = this.members.get(data.roomId);
          if (roomMembers) {
            if (isOwner) {
              Array.from(roomMembers.entries()).forEach(([memberId, existingMember]) => {
                if (existingMember.isOwner && memberId !== userId) {
                  roomMembers.delete(memberId);
                }
              });
            }

            roomMembers.set(userId, member);
            room.memberCount = roomMembers.size;
            this.rooms.set(data.roomId, room);
          }

          this.socketToRoom.set(socket.id, {
            roomId: data.roomId,
            userId,
            userName: data.userName,
            isOwner: isOwner,
          });

          socket.join(data.roomId);
          socket.to(data.roomId).emit('room:member-joined', member);

          console.log(`[WatchRoom] User ${data.userName} joined room ${data.roomId}${isOwner ? ' (as owner)' : ''}`);

          const members = Array.from(roomMembers?.values() || []);
          callback({ success: true, room, members });
        } catch (error) {
          console.error('[WatchRoom] Error joining room:', error);
          callback({ success: false, error: '加入房间失败' });
        }
      });

      // 离开房间
      socket.on('room:leave', () => {
        this.handleLeaveRoom(socket);
      });

      // 获取房间列表
      socket.on('room:list', (callback) => {
        const publicRooms = Array.from(this.rooms.values()).filter((room) => room.isPublic);
        callback(publicRooms);
      });

      // 播放状态更新（任何成员都可以触发同步）
      socket.on('play:update', (state) => {
        console.log(`[WatchRoom] Received play:update from ${socket.id}:`, state);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          console.log('[WatchRoom] No room info for socket, ignoring play:update');
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          console.log(`[WatchRoom] Broadcasting play:update to room ${roomInfo.roomId} from ${roomInfo.userName}`);
          socket.to(roomInfo.roomId).emit('play:update', state);
        } else {
          console.log('[WatchRoom] Room not found for play:update');
        }
      });

      // 播放进度跳转
      socket.on('play:seek', (currentTime) => {
        console.log(`[WatchRoom] Received play:seek from ${socket.id}:`, currentTime);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          console.log('[WatchRoom] No room info for socket, ignoring play:seek');
          return;
        }
        console.log(`[WatchRoom] Broadcasting play:seek to room ${roomInfo.roomId}`);
        socket.to(roomInfo.roomId).emit('play:seek', currentTime);
      });

      // 播放
      socket.on('play:play', () => {
        console.log(`[WatchRoom] Received play:play from ${socket.id}`);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          console.log('[WatchRoom] No room info for socket, ignoring play:play');
          return;
        }
        console.log(`[WatchRoom] Broadcasting play:play to room ${roomInfo.roomId}`);
        socket.to(roomInfo.roomId).emit('play:play');
      });

      // 暂停
      socket.on('play:pause', () => {
        console.log(`[WatchRoom] Received play:pause from ${socket.id}`);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) {
          console.log('[WatchRoom] No room info for socket, ignoring play:pause');
          return;
        }
        console.log(`[WatchRoom] Broadcasting play:pause to room ${roomInfo.roomId}`);
        socket.to(roomInfo.roomId).emit('play:pause');
      });

      // 切换视频/集数
      socket.on('play:change', (state) => {
        console.log(`[WatchRoom] Received play:change from ${socket.id}:`, state);
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) {
          console.log('[WatchRoom] No room info for socket, ignoring play:change');
          return;
        }
        if (!roomInfo.isOwner) {
          console.log('[WatchRoom] User is not owner, ignoring play:change');
          return;
        }

        const room = this.rooms.get(roomInfo.roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          console.log(`[WatchRoom] Broadcasting play:change to room ${roomInfo.roomId}`);
          socket.to(roomInfo.roomId).emit('play:change', state);
        } else {
          console.log('[WatchRoom] Room not found for play:change');
        }
      });

      // 切换直播频道
      socket.on('live:change', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('live:change', state);
        }
      });

      socket.on('music:change', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:change', state);
        }
      });

      socket.on('music:update', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:update', state);
        }
      });

      socket.on('music:queue', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = state;
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:queue', state);
        }
      });

      socket.on('music:play', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = { ...state, isPlaying: true };
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:play', state);
        }
      });

      socket.on('music:pause', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = { ...state, isPlaying: false };
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:pause', state);
        }
      });

      socket.on('music:seek', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo || !roomInfo.isOwner) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (room?.roomType === 'music') {
          room.currentState = { ...state };
          this.rooms.set(roomInfo.roomId, room);
          socket.to(roomInfo.roomId).emit('music:seek', state);
        }
      });

      socket.on('screen:helper-register', (data, callback) => {
        try {
          const room = this.rooms.get(data.roomId);
          if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
          }

          if (room.ownerToken !== data.ownerToken) {
            callback({ success: false, error: '房主身份验证失败' });
            return;
          }

          const oldHelperSocketId = this.screenHelpers.get(data.roomId);
          if (oldHelperSocketId && oldHelperSocketId !== socket.id) {
            this.helperToRoom.delete(oldHelperSocketId);
          }

          this.screenHelpers.set(data.roomId, socket.id);
          this.helperToRoom.set(socket.id, data.roomId);
          callback({ success: true });
        } catch (error) {
          console.error('[WatchRoom] Error registering screen helper:', error);
          callback({ success: false, error: '注册共享控制窗口失败' });
        }
      });

      // 开始屏幕共享
      socket.on('screen:start', (state) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        const roomId = roomInfo?.roomId || helperRoomId;
        if (!roomId) return;
        if (helperRoomId && this.screenHelpers.get(helperRoomId) !== socket.id) return;
        if (roomInfo && !roomInfo.isOwner) return;

        const room = this.rooms.get(roomId);
        if (room) {
          room.currentState = state;
          this.rooms.set(roomId, room);
          this.io.to(roomId).emit('screen:start', state);
        }
      });

      // 停止屏幕共享
      socket.on('screen:stop', () => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        const roomId = roomInfo?.roomId || helperRoomId;
        if (!roomId) return;
        if (helperRoomId && this.screenHelpers.get(helperRoomId) !== socket.id) return;
        if (roomInfo && !roomInfo.isOwner) return;

        const room = this.rooms.get(roomId);
        if (room) {
          room.currentState = null;
          this.rooms.set(roomId, room);
          this.io.to(roomId).emit('screen:stop');
        }
      });

      socket.on('screen:viewer-ready', () => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        const room = this.rooms.get(roomInfo.roomId);
        if (!room || roomInfo.isOwner || room.currentState?.type !== 'screen') return;

        const targetSocketId = this.screenHelpers.get(roomInfo.roomId) || room.ownerId;
        this.io.to(targetSocketId).emit('screen:viewer-ready', {
          userId: socket.id,
        });
      });

      // 屏幕共享 WebRTC 信令
      socket.on('screen:offer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (!roomInfo && !helperRoomId) return;

        this.io.to(data.targetUserId).emit('screen:offer', {
          userId: socket.id,
          offer: data.offer,
        });
      });

      socket.on('screen:answer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (!roomInfo && !helperRoomId) return;

        this.io.to(data.targetUserId).emit('screen:answer', {
          userId: socket.id,
          answer: data.answer,
        });
      });

      socket.on('screen:ice', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (!roomInfo && !helperRoomId) return;

        this.io.to(data.targetUserId).emit('screen:ice', {
          userId: socket.id,
          candidate: data.candidate,
        });
      });

      // 聊天消息
      socket.on('chat:message', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        const message = {
          id: this.generateMessageId(),
          userId: roomInfo.userId,
          userName: roomInfo.userName,
          content: data.content,
          type: data.type,
          timestamp: Date.now(),
        };

        this.io.to(roomInfo.roomId).emit('chat:message', message);
      });

      // WebRTC 信令
      socket.on('voice:offer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;
        this.io.to(data.targetUserId).emit('voice:offer', {
          userId: socket.id,
          offer: data.offer,
        });
      });

      socket.on('voice:answer', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;
        this.io.to(data.targetUserId).emit('voice:answer', {
          userId: socket.id,
          answer: data.answer,
        });
      });

      socket.on('voice:ice', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;
        this.io.to(data.targetUserId).emit('voice:ice', {
          userId: socket.id,
          candidate: data.candidate,
        });
      });

      // 语音聊天 - 服务器中转音频数据
      socket.on('voice:audio-chunk', (data) => {
        const roomInfo = this.socketToRoom.get(socket.id);
        if (!roomInfo) return;

        // 将音频数据转发给房间内的其他成员
        socket.to(roomInfo.roomId).emit('voice:audio-chunk', {
          userId: socket.id,
          audioData: data.audioData,
          sampleRate: data.sampleRate || 16000,
        });
      });

      // 心跳
      socket.on('heartbeat', () => {
        const roomInfo = this.socketToRoom.get(socket.id);

        // 如果用户在房间中，更新心跳时间
        if (roomInfo) {
          const roomMembers = this.members.get(roomInfo.roomId);
          const member = roomMembers?.get(roomInfo.userId);
          if (member) {
            member.lastHeartbeat = Date.now();
            roomMembers?.set(roomInfo.userId, member);
          }

          if (roomInfo.isOwner) {
            const room = this.rooms.get(roomInfo.roomId);
            if (room) {
              room.lastOwnerHeartbeat = Date.now();
              this.rooms.set(roomInfo.roomId, room);
            }
          }
        }

        // 无论是否在房间中，都响应心跳包（pong）
        socket.emit('heartbeat:pong', { timestamp: Date.now() });
      });

      // 断开连接
      socket.on('disconnect', () => {
        console.log(`[WatchRoom] Client disconnected: ${socket.id}`);
        const helperRoomId = this.helperToRoom.get(socket.id);
        if (helperRoomId) {
          this.helperToRoom.delete(socket.id);
          if (this.screenHelpers.get(helperRoomId) === socket.id) {
            this.screenHelpers.delete(helperRoomId);
            const room = this.rooms.get(helperRoomId);
            if (room && room.currentState?.type === 'screen') {
              room.currentState = null;
              this.rooms.set(helperRoomId, room);
              this.io.to(helperRoomId).emit('screen:stop');
            }
          }
        }
        this.handleLeaveRoom(socket);
      });
    });
  }

  handleLeaveRoom(socket) {
    const roomInfo = this.socketToRoom.get(socket.id);
    if (!roomInfo) return;

    const { roomId, userId, isOwner } = roomInfo;
    const room = this.rooms.get(roomId);
    const roomMembers = this.members.get(roomId);

    if (roomMembers) {
      roomMembers.delete(userId);

      if (room) {
        room.memberCount = roomMembers.size;
        this.rooms.set(roomId, room);
      }

      socket.to(roomId).emit('room:member-left', userId);

      // 如果是房主主动离开，解散房间并踢出所有成员
      if (isOwner) {
        console.log(`[WatchRoom] Owner actively left room ${roomId}, disbanding room`);

        // 通知所有成员房间被解散
        socket.to(roomId).emit('room:deleted', { reason: 'owner_left' });

        // 强制所有成员离开房间
        const members = Array.from(roomMembers.keys());
        members.forEach(memberId => {
          this.socketToRoom.delete(memberId);
        });

        // 立即删除房间（跳过通知，因为上面已经发送了）
        this.deleteRoom(roomId, true);

        // 清除可能存在的删除定时器
        if (this.roomDeletionTimers.has(roomId)) {
          clearTimeout(this.roomDeletionTimers.get(roomId));
          this.roomDeletionTimers.delete(roomId);
        }
      } else {
        // 普通成员离开，房间为空时延迟删除
        if (roomMembers.size === 0) {
          console.log(`[WatchRoom] Room ${roomId} is now empty, will delete in 30 seconds if no one rejoins`);

          const deletionTimer = setTimeout(() => {
            // 再次检查房间是否仍然为空
            const currentRoomMembers = this.members.get(roomId);
            if (currentRoomMembers && currentRoomMembers.size === 0) {
              console.log(`[WatchRoom] Room ${roomId} deletion timer expired, deleting room`);
              this.deleteRoom(roomId);
              this.roomDeletionTimers.delete(roomId);
            }
          }, 30000); // 30秒后删除

          this.roomDeletionTimers.set(roomId, deletionTimer);
        }
      }
    }

    socket.leave(roomId);
    this.socketToRoom.delete(socket.id);
  }

  deleteRoom(roomId, skipNotify = false) {
    console.log(`[WatchRoom] Deleting room ${roomId}`);

    // 如果不跳过通知，则发送 room:deleted 事件
    if (!skipNotify) {
      this.io.to(roomId).emit('room:deleted');
    }

    this.rooms.delete(roomId);
    this.members.delete(roomId);
    const helperSocketId = this.screenHelpers.get(roomId);
    if (helperSocketId) {
      this.helperToRoom.delete(helperSocketId);
      this.screenHelpers.delete(roomId);
    }
  }

  startCleanupTimer() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const deleteTimeout = 5 * 60 * 1000; // 5分钟 - 删除房间
      const clearStateTimeout = 30 * 1000; // 30秒 - 清除播放状态

      for (const [roomId, room] of this.rooms.entries()) {
        const timeSinceHeartbeat = now - room.lastOwnerHeartbeat;

        // 如果房主心跳超过30秒，清除播放状态
        if (timeSinceHeartbeat > clearStateTimeout && room.currentState !== null) {
          console.log(`[WatchRoom] Room ${roomId} owner inactive for 30s, clearing play state`);
          room.currentState = null;
          this.rooms.set(roomId, room);
          // 通知房间内所有成员状态已清除
          this.io.to(roomId).emit('state:cleared');
        }

        // 检查房主是否超时5分钟 - 删除房间
        if (timeSinceHeartbeat > deleteTimeout) {
          console.log(`[WatchRoom] Room ${roomId} owner timeout, deleting...`);
          this.deleteRoom(roomId);
        }
      }
    }, 10000); // 每10秒检查一次，确保更及时的清理
  }

  generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  generateMessageId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // 清理所有房间删除定时器
    for (const timer of this.roomDeletionTimers.values()) {
      clearTimeout(timer);
    }
    this.roomDeletionTimers.clear();
  }
}

function parseCookieHeader(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index <= 0) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = value;
    return acc;
  }, {});
}

function parseSocketAuth(socket) {
  const cookies = parseCookieHeader(socket.handshake.headers.cookie || '');
  const raw = cookies.auth || socket.handshake.auth?.token || '';
  if (!raw) return null;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}

  if (decoded.includes('%')) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {}
  }

  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

class TVRemoteServer {
  constructor(io) {
    this.io = io;
    this.cleanupInterval = null;
    attachTVRemoteIO(io);
    this.setupEventHandlers();
    this.startCleanupTimer();
  }

  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      socket.on('tv-remote:register-tv', (data, callback) => {
        const auth = parseSocketAuth(socket);
        if (!auth?.username) {
          callback?.({ success: false, error: '未登录' });
          return;
        }

        const deviceId = String(data?.deviceId || '').slice(0, 128);
        if (!deviceId) {
          callback?.({ success: false, error: '缺少设备 ID' });
          return;
        }

        callback?.(registerTVRemoteDevice(socket.id, auth.username, data));
      });

      socket.on('tv-remote:tv-state', (data) => {
        const auth = parseSocketAuth(socket);
        if (!auth?.username) return;
        updateTVRemoteDevice(socket.id, auth.username, data);
      });

      socket.on('disconnect', () => {
        removeTVRemoteSocket(socket.id);
      });
    });
  }

  startCleanupTimer() {
    this.cleanupInterval = setInterval(() => {
      cleanupTVRemoteDevices();
    }, 30_000);
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    clearTVRemoteHub();
  }
}

// ---------------------------------------------------------------------------
// 兼容性自检探针 /__compat
//
// 为什么要有它：站长的 2345 浏览器报了一串只在老内核上出现的问题（封面不显示、
// 点影片报「连接已重置」、换源/弹幕面板文字看不清、选集点不动）。这类问题无法
// 在本机复现 —— 必须拿到**那台浏览器自己的**内核版本、CSS 支持情况、接口连通性
// 与页面实测尺寸。这个探针让站长只做一件事：打开 `http://<站点>/__compat`，
// 页面自检后把 JSON POST 回来，服务端打进容器日志，然后用
// `docker logs mytv-core | grep '\[compat\]'` 直接读结论 —— 不用再靠猜。
//
// 安全：只记录、不回显；请求体上限 8KB；只打印 UA + 路径，不打印查询串
// （站点 URL 里带了片源 id 之类的参数，没必要进日志）。
// ---------------------------------------------------------------------------
const COMPAT_BODY_LIMIT = 8 * 1024;

function sendCompatReport(req, res) {
  let body = '';
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    body += chunk;
    if (body.length > COMPAT_BODY_LIMIT) {
      aborted = true;
      res.statusCode = 413;
      res.end('too large');
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    console.log(`[compat] ${body.slice(0, COMPAT_BODY_LIMIT)}`);
    res.statusCode = 204;
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  });
}

function compatPage() {
  // 说明：这一页必须是**纯 ES5**（var / function / 字符串拼接，不用箭头函数、
  // 模板字符串、const/let），否则老内核加载它就 SyntaxError，探针自己先挂了。
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>浏览器兼容性自检</title>',
    '<style>',
    'body{font:14px/1.6 -apple-system,"Segoe UI",sans-serif;margin:0;padding:16px;background:#0f172a;color:#e2e8f0}',
    'h1{font-size:17px;margin:0 0 4px}p.sub{color:#94a3b8;margin:0 0 14px}',
    'table{border-collapse:collapse;width:100%;max-width:860px;margin-bottom:18px}',
    'td,th{border:1px solid #334155;padding:4px 8px;text-align:left;vertical-align:top}',
    'th{background:#1e293b;width:210px;font-weight:600}',
    '.ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}',
    'code{color:#93c5fd}#state{margin:12px 0;padding:10px;border-radius:6px;background:#1e293b}',
    'iframe{position:fixed;left:-2200px;top:0;width:1280px;height:1000px;border:0}',
    '</style></head><body>',
    '<h1>浏览器兼容性自检</h1>',
    '<p class="sub">本页在你的浏览器里跑一遍特征检测，并把结果回传给服务器日志（站长无需操作）。</p>',
    '<div id="state">检测中…</div><div id="out"></div>',
    '<iframe id="probe" src="/"></iframe>',
    '<script>',
    'var R={};var pending=0;var T0=Date.now();',
    'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")}',
    // T(): 同步项直接取值；返回 Promise 的异步项登记到 pending，落地后再补表。
    'function T(name,fn){var v;try{v=fn()}catch(e){v="throw: "+(e&&e.message)}',
    'if(v&&typeof v.then==="function"){pending++;R[name]="…检测中";v.then(function(x){R[name]=x;pending--;render()},function(e){R[name]="rejected: "+(e&&e.message);pending--;render()})}',
    'else{R[name]=v}return v}',
    'function cls(v){return v===true?"ok":v===false?"bad":"warn"}',
    'function row(k,v){var s=(v&&typeof v==="object")?JSON.stringify(v):String(v);return "<tr><th>"+esc(k)+"</th><td class=\\""+cls(v)+"\\">"+esc(s)+"</td></tr>"}',
    'function render(){var h="";for(var k in R){h+=row(k,R[k])}document.getElementById("out").innerHTML="<table>"+h+"</table>"}',
    // —— 环境 ——
    'T("userAgent",function(){return navigator.userAgent});',
    'T("平台",function(){return navigator.platform+" / "+navigator.vendor});',
    'T("视口",function(){return window.innerWidth+"x"+window.innerHeight+" dpr="+window.devicePixelRatio});',
    'T("html class（主题）",function(){return document.documentElement.className||"(空=浅色)"});',
    'T("系统深色偏好",function(){return window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches});',
    'T("cookie 可用",function(){document.cookie="__c=1;path=/";var ok=document.cookie.indexOf("__c=1")>=0;document.cookie="__c=;max-age=0;path=/";return navigator.cookieEnabled&&ok});',
    // —— 老内核关键 API（true 才正常）——
    'T("Array.prototype.at",function(){return typeof [].at==="function"});',
    'T("Object.hasOwn",function(){return typeof Object.hasOwn==="function"});',
    'T("URL.canParse",function(){return typeof URL.canParse==="function"});',
    'T("String.replaceAll",function(){return typeof "".replaceAll==="function"});',
    'T("structuredClone",function(){return typeof structuredClone==="function"});',
    'T("Promise.allSettled",function(){return typeof Promise.allSettled==="function"});',
    'T("ResizeObserver",function(){return typeof ResizeObserver==="function"});',
    'T("IntersectionObserver",function(){return typeof IntersectionObserver==="function"});',
    'T("AbortController",function(){return typeof AbortController==="function"});',
    // —— CSS：既查 CSS.supports，也做**真实测量**（supports 在某些内核上不可靠）——
    'T("CSS.supports(aspect-ratio)",function(){return CSS.supports&&CSS.supports("aspect-ratio","2/3")});',
    'T("实测 aspect-ratio",function(){var d=document.createElement("div");d.style.cssText="width:100px;aspect-ratio:2/3";document.body.appendChild(d);var h=d.offsetHeight;d.parentNode.removeChild(d);return h===150?"150 ✓":("高 "+h+" ✗（应为 150）")});',
    'T("实测 inset:0",function(){var o=document.createElement("div");o.style.cssText="position:relative;width:50px;height:50px";var i=document.createElement("div");i.style.cssText="position:absolute;inset:0";o.appendChild(i);document.body.appendChild(o);var w=i.offsetWidth;o.parentNode.removeChild(o);return w===50?"50 ✓":("宽 "+w+" ✗（应为 50）")});',
    'T("实测 flex gap",function(){var o=document.createElement("div");o.style.cssText="display:flex;gap:10px;position:absolute;left:-9999px";for(var n=0;n<2;n++){var c=document.createElement("div");c.style.cssText="width:10px;height:10px";o.appendChild(c)}document.body.appendChild(o);var gap=o.children[1].offsetLeft-o.children[0].offsetLeft;o.parentNode.removeChild(o);return gap===20?"20 ✓":(gap+" ✗（应为 20）")});',
    'T("CSS.supports(:is())",function(){return CSS.supports&&CSS.supports("selector(:is(a))")});',
    // —— Service Worker（上一版它给导航/接口套了 10 秒超时，是主要故障源）——
    'T("SW 支持",function(){return "serviceWorker" in navigator});',
    'T("SW 已注册数",function(){if(!navigator.serviceWorker||!navigator.serviceWorker.getRegistrations)return "不支持";return new Promise(function(r){navigator.serviceWorker.getRegistrations().then(function(l){r(l.length+" 个"+(l[0]&&l[0].active?" / "+l[0].active.scriptURL:""))}).catch(function(e){r("查询失败: "+e.message)})})});',
    'T("SW 正在接管本页",function(){return !!(navigator.serviceWorker&&navigator.serviceWorker.controller)});',
    'render();',
    // —— 接口与图片连通性 ——
    'function xhr(url,ms,cb){var x=new XMLHttpRequest();var t0=Date.now();var done=false;x.open("GET",url,true);x.timeout=ms;x.onreadystatechange=function(){if(done)return;if(x.readyState===4){done=true;cb(x.status,Date.now()-t0)}};x.ontimeout=function(){if(done)return;done=true;cb("timeout",Date.now()-t0)};x.onerror=function(){if(done)return;done=true;cb("network-error",Date.now()-t0)};x.send()}',
    'function imgTest(url,ms,cb){var im=new Image();var t0=Date.now();var done=false;var fin=function(r){if(done)return;done=true;cb(r,Date.now()-t0)};var timer=setTimeout(function(){fin("timeout")},ms);im.onload=function(){clearTimeout(timer);fin("ok "+im.naturalWidth+"x"+im.naturalHeight)};im.onerror=function(){clearTimeout(timer);fin("error")};im.src=url}',
    'T("接口 /api/server-config",function(){return new Promise(function(r){xhr("/api/server-config",15000,function(s,ms){r(s+" / "+ms+"ms")})})});',
    'T("同源图片 /logo.png",function(){return new Promise(function(r){imgTest("/logo.png",15000,function(s,ms){r(s+" / "+ms+"ms")})})});',
    'T("跨域图片（豆瓣海报）",function(){return new Promise(function(r){imgTest("https://img1.doubanio.com/view/photo/s_ratio_poster/public/p480747492.jpg",20000,function(s,ms){r(s+" / "+ms+"ms")})})});',
    // —— 真实页面实测：把首页放进 iframe 量尺寸（同源可直接读 DOM）——
    'function probeFrame(){try{var f=document.getElementById("probe");var d=f.contentDocument;if(!d){R["首页实测"]="读不到 iframe 文档";render();return}var imgs=d.querySelectorAll("img");var total=imgs.length,loaded=0,zero=0,zeroList=[];for(var i=0;i<total&&i<80;i++){var im=imgs[i];if(im.naturalWidth>0)loaded++;var box=im.parentElement;var h=box?box.offsetHeight:0;if(h===0){zero++;if(zeroList.length<3)zeroList.push((im.currentSrc||im.src||"").slice(0,90))}}R["首页实测"]="标题「"+(d.title||"")+"」 / img "+total+" 个 / 载入成功 "+loaded+" / 容器高度为 0 的 "+zero;R["零高度样例"]=zeroList.length?zeroList:"(无)";R["首页 html class"]=d.documentElement.className||"(空=浅色)"}catch(e){R["首页实测"]="异常: "+(e&&e.message)}render()}',
    'setTimeout(probeFrame,4500);',
    // 等所有异步项落地 + iframe 实测完成再回传；最迟 26 秒兜底。
    'function post(){var payload={};for(var k in R){payload[k]=R[k]}payload.href=location.href.split("?")[0];var x=new XMLHttpRequest();x.open("POST","/__compat",true);x.setRequestHeader("Content-Type","application/json");try{x.send(JSON.stringify(payload))}catch(e){}document.getElementById("state").innerHTML="<b>已回传服务器日志</b>（日志里查 <code>[compat]</code>）。<span class=\\"ok\\">正常</span> / <span class=\\"bad\\">异常</span> / <span class=\\"warn\\">未知</span>"}',
    'function maybePost(){var el=Date.now()-T0;if((pending===0&&el>6000)||el>26000){post();return}setTimeout(maybePost,500)}',
    'setTimeout(maybePost,6000);',
    '<' + '/script></body></html>',
  ].join('\n');
}

/** 只记录「页面导航」与「失败请求」，音量很小；只打路径不打查询串。 */
function logAccess(req, res) {
  const started = Date.now();
  res.on('finish', () => {
    const isDocument = (req.headers.accept || '').includes('text/html');
    const failed = res.statusCode >= 400;
    if (!isDocument && !failed) return;
    let pathname = req.url || '';
    const q = pathname.indexOf('?');
    if (q >= 0) pathname = pathname.slice(0, q);
    if (pathname.startsWith('/_next/')) return;
    const ua = (req.headers['user-agent'] || '').slice(0, 140);
    console.log(
      `[access] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms ua="${ua}"`
    );
  });
}

const ACCESS_LOG_ENABLED = process.env.MYTV_ACCESS_LOG !== 'false';

app.prepare().then(async () => {
  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);

      // 兼容性自检探针（不走 Next，也不需要登录）
      if (parsedUrl.pathname === '/__compat') {
        if (req.method === 'POST') {
          sendCompatReport(req, res);
        } else {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(compatPage());
        }
        return;
      }

      if (ACCESS_LOG_ENABLED) logAccess(req, res);

      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  // ── keep-alive 竞态：老浏览器「连接已重置」的一个常见根因 ──────────────
  // Node 默认 keepAliveTimeout 只有 5 秒：空闲超时后服务器单方面关掉连接，
  // 而浏览器可能恰好在同一瞬间复用这条连接发请求，于是内核回 RST，
  // 浏览器报 ERR_CONNECTION_RESET。现代 Chrome 会自动换连接重试掩盖了它，
  // 老内核（国产双核浏览器）不一定重试，就直接把错误摊到用户脸上。
  // 把空闲超时抬到 65 秒即可让"服务器先关"这件事基本不再发生。
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

  // 读取观影室配置
  const watchRoomConfig = await getWatchRoomConfig();
  console.log('[WatchRoom] Config:', watchRoomConfig);

  let watchRoomServer = null;
  let tvRemoteServer = null;
  let io = null;

  const tvModeEnabled = isTVModeEnabled();
  const shouldStartInternalWatchRoom =
    watchRoomConfig.enabled && watchRoomConfig.serverType === 'internal';

  if (tvModeEnabled || shouldStartInternalWatchRoom) {
    io = new Server(httpServer, {
      path: '/socket.io',
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });
  }

  if (tvModeEnabled && io) {
    tvRemoteServer = new TVRemoteServer(io);
    console.log('[TVRemote] Socket.IO remote server initialized');
  } else {
    console.log('[TVRemote] TV mode disabled, remote server not initialized');
  }

  if (shouldStartInternalWatchRoom && io) {
    // 初始化观影室服务器
    watchRoomServer = new WatchRoomServer(io);
    console.log('[WatchRoom] Socket.IO server initialized');
  } else {
    if (!watchRoomConfig.enabled) {
      console.log('[WatchRoom] Watch room is disabled');
    } else if (watchRoomConfig.serverType === 'external') {
      console.log('[WatchRoom] Using external watch room server');
    }
  }

  httpServer
    .once('error', (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`> Ready on http://${hostname}:${port}`);
      if (io) {
        console.log(`> Socket.IO ready on ws://${hostname}:${port}`);
      } else {
        console.log('> Socket.IO disabled');
      }
    });

  const forceExit = (signal) => {
    console.log(`\n[Server] Received ${signal}, force exiting...`);
    process.exit(0);
  };

  process.on('SIGINT', () => forceExit('SIGINT'));
  process.on('SIGTERM', () => forceExit('SIGTERM'));
});
