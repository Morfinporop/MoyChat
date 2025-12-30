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

// База данных (в памяти)
let users = new Map(); // id -> {username, socketId, friends, servers}
let servers = new Map(); // serverId -> {name, channels, members}
let messages = new Map(); // channelId -> [{user, message, time}]
let directMessages = new Map(); // "user1-user2" -> [{from, message, time}]
let voiceRooms = new Map(); // roomId -> [socketIds]

// Создание дефолтного сервера
const defaultServer = {
  id: 'default',
  name: '☕ Кофейня',
  channels: [
    { id: 'general', name: 'общий-чат', type: 'text' },
    { id: 'voice1', name: 'Голосовая комната', type: 'voice' }
  ],
  members: []
};
servers.set('default', defaultServer);
messages.set('general', []);

io.on('connection', (socket) => {
  console.log('🟢 Подключился:', socket.id);

  // Регистрация пользователя
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

    // Добавляем в дефолтный сервер
    const server = servers.get('default');
    if (!server.members.includes(userId)) {
      server.members.push(userId);
    }

    socket.join('default');
    socket.join('general');

    // Отправляем данные пользователю
    socket.emit('init', {
      userId: userId,
      servers: getUserServers(userId),
      friends: getUserFriends(userId)
    });

    // Уведомляем всех
    io.emit('user-status', {
      userId: userId,
      username: username,
      status: 'online'
    });

    // Отправляем историю сообщений
    socket.emit('message-history', {
      channelId: 'general',
      messages: messages.get('general') || []
    });
  });

  // Отправка сообщения в канал
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

    // Сохраняем сообщение
    if (!messages.has(data.channelId)) {
      messages.set(data.channelId, []);
    }
    messages.get(data.channelId).push(messageObj);

    // Отправляем всем в канале
    io.to(data.channelId).emit('new-message', {
      channelId: data.channelId,
      message: messageObj
    });
  });

  // Личное сообщение
  socket.on('send-dm', (data) => {
    const sender = users.get(socket.id);
    const recipient = users.get(data.recipientId);
    
    if (!sender || !recipient) return;

    const dmKey = [sender.id, recipient.id].sort().join('-');
    
    if (!directMessages.has(dmKey)) {
      directMessages.set(dmKey, []);
    }

    const messageObj = {
      id: Date.now(),
      from: sender.id,
      fromName: sender.username,
      message: data.message,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    };

    directMessages.get(dmKey).push(messageObj);

    // Отправляем обоим
    socket.emit('new-dm', { recipientId: recipient.id, message: messageObj });
    io.to(recipient.socketId).emit('new-dm', { recipientId: sender.id, message: messageObj });
  });

  // Получить историю ЛС
  socket.on('get-dm-history', (recipientId) => {
    const sender = users.get(socket.id);
    if (!sender) return;

    const dmKey = [sender.id, recipientId].sort().join('-');
    const history = directMessages.get(dmKey) || [];

    socket.emit('dm-history', {
      recipientId: recipientId,
      messages: history
    });
  });

  // Добавить в друзья
  socket.on('add-friend', (friendUsername) => {
    const user = users.get(socket.id);
    if (!user) return;

    // Ищем друга по имени
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

      socket.emit('notification', `✅ ${friendUser.username} добавлен в друзья!`);
    } else {
      socket.emit('notification', '❌ Пользователь не найден или уже в друзьях');
    }
  });

  // Создать сервер
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
    socket.emit('notification', `✅ Сервер "${serverName}" создан!`);
  });

  // Присоединиться к голосовому каналу
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

    // Уведомляем всех в комнате
    io.to('voice-' + channelId).emit('user-joined-voice', {
      channelId: channelId,
      userId: user.id,
      username: user.username,
      users: room.map(id => users.get(id))
    });

    // Отправляем список пользователей
    socket.emit('voice-users', {
      channelId: channelId,
      users: room.map(id => users.get(id)).filter(u => u)
    });
  });

  // Покинуть голосовой канал
  socket.on('leave-voice', (channelId) => {
    leaveVoiceChannel(socket.id, channelId);
  });

  // WebRTC сигналинг
  socket.on('voice-offer', (data) => {
    io.to(data.to).emit('voice-offer', {
      from: socket.id,
      offer: data.offer
    });
  });

  socket.on('voice-answer', (data) => {
    io.to(data.to).emit('voice-answer', {
      from: socket.id,
      answer: data.answer
    });
  });

  socket.on('ice-candidate', (data) => {
    io.to(data.to).emit('ice-candidate', {
      from: socket.id,
      candidate: data.candidate
    });
  });

  // Отключение
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      io.emit('user-status', {
        userId: user.id,
        username: user.username,
        status: 'offline'
      });

      // Удаляем из голосовых комнат
      for (let [channelId, room] of voiceRooms.entries()) {
        leaveVoiceChannel(socket.id, channelId);
      }

      users.delete(socket.id);
    }
    console.log('🔴 Отключился:', socket.id);
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
  console.log('🚀 Сервер запущен на порту:', PORT);
  console.log('📡 Локально: http://localhost:' + PORT);
});