const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Database
let users = new Map();
let servers = new Map();
let messages = new Map();
let directMessages = new Map();
let voiceRooms = new Map();

// Default server
const defaultServer = {
  id: 'default',
  name: 'Sicore',
  channels: [
    { id: 'general', name: 'общий-чат', type: 'text' },
    { id: 'voice1', name: 'Голосовая комната', type: 'voice' }
  ],
  members: []
};
servers.set('default', defaultServer);
messages.set('general', []);

io.on('connection', (socket) => {
  console.log('🟢 Connected:', socket.id);

  socket.on('register', (username) => {
    const userId = socket.id;
    users.set(userId, {
      id: userId,
      username: username,
      socketId: socket.id,
      friends: [],
      servers: ['default'],
      status: 'online'
    });

    const server = servers.get('default');
    if (!server.members.includes(userId)) {
      server.members.push(userId);
    }

    socket.join('default');
    socket.join('general');

    socket.emit('init', {
      userId: userId,
      username: username,
      servers: getUserServers(userId),
      friends: getUserFriends(userId)
    });

    io.emit('user-status', {
      userId: userId,
      username: username,
      status: 'online'
    });

    socket.emit('message-history', {
      channelId: 'general',
      messages: messages.get('general') || []
    });
  });

  socket.on('send-message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const messageObj = {
      id: Date.now(),
      userId: user.id,
      username: user.username,
      message: data.message,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    };

    if (!messages.has(data.channelId)) {
      messages.set(data.channelId, []);
    }
    messages.get(data.channelId).push(messageObj);

    io.to(data.channelId).emit('new-message', {
      channelId: data.channelId,
      message: messageObj
    });
  });

  socket.on('get-channel-messages', (channelId) => {
    socket.emit('message-history', {
      channelId: channelId,
      messages: messages.get(channelId) || []
    });
  });

  socket.on('add-friend', (friendUsername) => {
    const user = users.get(socket.id);
    if (!user) return;

    let friendUser = null;
    for (let [id, u] of users.entries()) {
      if (u.username.toLowerCase() === friendUsername.toLowerCase() && id !== user.id) {
        friendUser = u;
        break;
      }
    }

    if (friendUser && !user.friends.includes(friendUser.id)) {
      user.friends.push(friendUser.id);
      friendUser.friends.push(user.id);

      socket.emit('friend-added', {
        id: friendUser.id,
        username: friendUser.username,
        status: friendUser.status
      });

      io.to(friendUser.socketId).emit('friend-added', {
        id: user.id,
        username: user.username,
        status: user.status
      });
    }
  });

  socket.on('create-server', (serverName) => {
    const user = users.get(socket.id);
    if (!user) return;

    const serverId = 'server-' + Date.now();
    const newServer = {
      id: serverId,
      name: serverName,
      owner: user.id,
      channels: [
        { id: serverId + '-general', name: 'общий', type: 'text' },
        { id: serverId + '-voice', name: 'Голосовой', type: 'voice' }
      ],
      members: [user.id]
    };

    servers.set(serverId, newServer);
    user.servers.push(serverId);
    messages.set(serverId + '-general', []);

    socket.join(serverId);
    socket.join(serverId + '-general');

    socket.emit('server-created', newServer);
  });

  socket.on('create-channel', (data) => {
    const server = servers.get(data.serverId);
    if (!server) return;

    const channelId = data.serverId + '-' + Date.now();
    const newChannel = {
      id: channelId,
      name: data.name,
      type: data.type
    };

    server.channels.push(newChannel);
    
    if (data.type === 'text') {
      messages.set(channelId, []);
    }

    io.emit('channel-created', { serverId: data.serverId, channel: newChannel });
  });

  socket.on('join-voice', (channelId) => {
    const user = users.get(socket.id);
    if (!user) return;

    if (!voiceRooms.has(channelId)) {
      voiceRooms.set(channelId, []);
    }

    const room = voiceRooms.get(channelId);
    if (!room.includes(socket.id)) {
      room.push(socket.id);
    }

    socket.join('voice-' + channelId);

    io.to('voice-' + channelId).emit('user-joined-voice', {
      channelId: channelId,
      userId: user.id,
      username: user.username,
      users: room.map(id => users.get(id)).filter(u => u)
    });
  });

  socket.on('leave-voice', (channelId) => {
    leaveVoiceChannel(socket.id, channelId);
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      io.emit('user-status', {
        userId: user.id,
        username: user.username,
        status: 'offline'
      });

      for (let [channelId, room] of voiceRooms.entries()) {
        leaveVoiceChannel(socket.id, channelId);
      }

      users.delete(socket.id);
    }
    console.log('🔴 Disconnected:', socket.id);
  });
});

function leaveVoiceChannel(socketId, channelId) {
  if (voiceRooms.has(channelId)) {
    const room = voiceRooms.get(channelId);
    const index = room.indexOf(socketId);
    if (index > -1) {
      room.splice(index, 1);
      const user = users.get(socketId);
      
      io.to('voice-' + channelId).emit('user-left-voice', {
        channelId: channelId,
        userId: socketId,
        username: user ? user.username : 'Unknown'
      });
    }
  }
}

function getUserServers(userId) {
  const user = users.get(userId);
  if (!user) return [];
  
  return user.servers.map(serverId => servers.get(serverId)).filter(s => s);
}

function getUserFriends(userId) {
  const user = users.get(userId);
  if (!user) return [];
  
  return user.friends.map(friendId => {
    const friend = users.get(friendId);
    return friend ? {
      id: friend.id,
      username: friend.username,
      status: friend.status
    } : null;
  }).filter(f => f);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log('🚀 Server running on port:', PORT);
});
