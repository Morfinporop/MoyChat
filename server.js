const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const bcrypt = require('bcrypt');
const session = require('express-session');

app.use(express.json());
app.use(express.static(__dirname));
app.use(session({
  secret: 'sicore-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 дней
}));

// База данных (в памяти)
let users = new Map(); // email -> {name, login, email, password, avatar, friends, friendRequests, groups}
let onlineUsers = new Map(); // socketId -> userEmail
let groups = new Map(); // groupId -> {name, avatar, type, channels, members, roles}
let messages = new Map(); // channelId/dmKey -> [messages]
let pinnedMessages = new Map(); // channelId -> [messageIds]

// Регистрация
app.post('/api/register', async (req, res) => {
  const { name, login, email, password } = req.body;
  
  if (users.has(email)) {
    return res.json({ success: false, error: 'Пользователь уже существует' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  
  users.set(email, {
    name,
    login,
    email,
    password: hashedPassword,
    avatar: name[0].toUpperCase(),
    friends: [],
    friendRequests: [],
    groups: [],
    createdAt: Date.now()
  });

  req.session.userEmail = email;
  res.json({ success: true, user: { name, login, email, avatar: name[0].toUpperCase() } });
});

// Вход
app.post('/api/login', async (req, res) => {
  const { email, password, remember } = req.body;
  
  const user = users.get(email);
  if (!user) {
    return res.json({ success: false, error: 'Пользователь не найден' });
  }

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    return res.json({ success: false, error: 'Неверный пароль' });
  }

  if (remember) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  }

  req.session.userEmail = email;
  res.json({ 
    success: true, 
    user: { 
      name: user.name, 
      login: user.login, 
      email: user.email, 
      avatar: user.avatar 
    } 
  });
});

// Проверка сессии
app.get('/api/check-session', (req, res) => {
  if (req.session.userEmail && users.has(req.session.userEmail)) {
    const user = users.get(req.session.userEmail);
    res.json({ 
      loggedIn: true, 
      user: { 
        name: user.name, 
        login: user.login, 
        email: user.email, 
        avatar: user.avatar 
      } 
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// Выход
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('🟢 Подключился:', socket.id);

  // Инициализация пользователя
  socket.on('init-user', (email) => {
    const user = users.get(email);
    if (!user) return;

    onlineUsers.set(socket.id, email);
    
    // Уведомляем друзей о статусе
    user.friends.forEach(friendEmail => {
      const friendSocketId = getSocketIdByEmail(friendEmail);
      if (friendSocketId) {
        io.to(friendSocketId).emit('friend-status', {
          email: email,
          status: 'online'
        });
      }
    });

    // Отправляем данные пользователю
    socket.emit('user-data', {
      friends: user.friends.map(email => {
        const friend = users.get(email);
        return {
          email: friend.email,
          name: friend.name,
          login: friend.login,
          avatar: friend.avatar,
          status: isUserOnline(email) ? 'online' : 'offline'
        };
      }),
      friendRequests: user.friendRequests.map(email => {
        const requester = users.get(email);
        return {
          email: requester.email,
          name: requester.name,
          login: requester.login,
          avatar: requester.avatar
        };
      }),
      groups: user.groups.map(groupId => groups.get(groupId))
    });
  });

  // Отправить запрос в друзья
  socket.on('send-friend-request', (targetLogin) => {
    const senderEmail = onlineUsers.get(socket.id);
    const sender = users.get(senderEmail);
    if (!sender) return;

    // Ищем пользователя по логину
    let targetUser = null;
    let targetEmail = null;
    for (let [email, user] of users.entries()) {
      if (user.login === targetLogin) {
        targetUser = user;
        targetEmail = email;
        break;
      }
    }

    if (!targetUser) {
      socket.emit('notification', { type: 'error', text: 'Пользователь не найден' });
      return;
    }

    if (targetUser.friendRequests.includes(senderEmail)) {
      socket.emit('notification', { type: 'error', text: 'Запрос уже отправлен' });
      return;
    }

    if (sender.friends.includes(targetEmail)) {
      socket.emit('notification', { type: 'error', text: 'Уже в друзьях' });
      return;
    }

    targetUser.friendRequests.push(senderEmail);

    // Уведомляем получателя
    const targetSocketId = getSocketIdByEmail(targetEmail);
    if (targetSocketId) {
      io.to(targetSocketId).emit('new-friend-request', {
        email: sender.email,
        name: sender.name,
        login: sender.login,
        avatar: sender.avatar
      });
    }

    socket.emit('notification', { type: 'success', text: 'Запрос отправлен' });
  });

  // Принять запрос в друзья
  socket.on('accept-friend-request', (requesterEmail) => {
    const userEmail = onlineUsers.get(socket.id);
    const user = users.get(userEmail);
    const requester = users.get(requesterEmail);
    
    if (!user || !requester) return;

    // Удаляем запрос
    user.friendRequests = user.friendRequests.filter(e => e !== requesterEmail);
    
    // Добавляем в друзья
    user.friends.push(requesterEmail);
    requester.friends.push(userEmail);

    // Уведомляем отправителя
    const requesterSocketId = getSocketIdByEmail(requesterEmail);
    if (requesterSocketId) {
      io.to(requesterSocketId).emit('friend-added', {
        email: user.email,
        name: user.name,
        login: user.login,
        avatar: user.avatar,
        status: 'online'
      });
    }

    socket.emit('friend-accepted', {
      email: requester.email,
      name: requester.name,
      login: requester.login,
      avatar: requester.avatar,
      status: isUserOnline(requesterEmail) ? 'online' : 'offline'
    });
  });

  // Отклонить запрос в друзья
  socket.on('reject-friend-request', (requesterEmail) => {
    const userEmail = onlineUsers.get(socket.id);
    const user = users.get(userEmail);
    
    if (!user) return;
    user.friendRequests = user.friendRequests.filter(e => e !== requesterEmail);
    
    socket.emit('friend-request-removed', requesterEmail);
  });

  // Отправить личное сообщение
  socket.on('send-dm', (data) => {
    const senderEmail = onlineUsers.get(socket.id);
    const sender = users.get(senderEmail);
    
    if (!sender) return;

    const dmKey = [senderEmail, data.recipientEmail].sort().join('_');
    
    if (!messages.has(dmKey)) {
      messages.set(dmKey, []);
    }

    const message = {
      id: Date.now() + Math.random(),
      from: senderEmail,
      fromName: sender.name,
      fromAvatar: sender.avatar,
      message: data.message,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    };

    messages.get(dmKey).push(message);

    // Отправляем обоим
    socket.emit('new-dm', { recipientEmail: data.recipientEmail, message });
    
    const recipientSocketId = getSocketIdByEmail(data.recipientEmail);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('new-dm', { recipientEmail: senderEmail, message });
    }
  });

  // Получить историю ЛС
  socket.on('get-dm-history', (recipientEmail) => {
    const senderEmail = onlineUsers.get(socket.id);
    const dmKey = [senderEmail, recipientEmail].sort().join('_');
    
    socket.emit('dm-history', {
      recipientEmail,
      messages: messages.get(dmKey) || []
    });
  });

  // Закрепить сообщение
  socket.on('pin-message', (data) => {
    const { chatId, messageId } = data;
    
    if (!pinnedMessages.has(chatId)) {
      pinnedMessages.set(chatId, []);
    }
    
    pinnedMessages.get(chatId).push(messageId);
    
    socket.emit('message-pinned', { chatId, messageId });
  });

  // Создать группу
  socket.on('create-group', (data) => {
    const creatorEmail = onlineUsers.get(socket.id);
    const creator = users.get(creatorEmail);
    
    if (!creator) return;

    const groupId = 'group_' + Date.now();
    const newGroup = {
      id: groupId,
      name: data.name,
      avatar: data.avatar || data.name[0].toUpperCase(),
      type: data.type,
      owner: creatorEmail,
      channels: [
        { id: groupId + '_general', name: 'основной', type: 'text' },
        { id: groupId + '_voice', name: 'Голосовой', type: 'voice' }
      ],
      members: [creatorEmail],
      roles: [
        { id: 'admin', name: 'Администратор', color: '#e74c3c', permissions: ['all'] },
        { id: 'member', name: 'Участник', color: '#95a5a6', permissions: ['read', 'write'] }
      ],
      memberRoles: { [creatorEmail]: 'admin' }
    };

    groups.set(groupId, newGroup);
    creator.groups.push(groupId);
    messages.set(groupId + '_general', []);

    socket.join(groupId);
    socket.emit('group-created', newGroup);
  });

  // Отправить сообщение в группу
  socket.on('send-group-message', (data) => {
    const senderEmail = onlineUsers.get(socket.id);
    const sender = users.get(senderEmail);
    
    if (!sender) return;

    const message = {
      id: Date.now() + Math.random(),
      from: senderEmail,
      fromName: sender.name,
      fromAvatar: sender.avatar,
      message: data.message,
      time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    };

    if (!messages.has(data.channelId)) {
      messages.set(data.channelId, []);
    }

    messages.get(data.channelId).push(message);

    io.to(data.groupId).emit('new-group-message', {
      channelId: data.channelId,
      message
    });
  });

  // WebRTC сигналинг для звонков
  socket.on('call-user', (data) => {
    const callerEmail = onlineUsers.get(socket.id);
    const caller = users.get(callerEmail);
    
    const recipientSocketId = getSocketIdByEmail(data.recipientEmail);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('incoming-call', {
        from: callerEmail,
        fromName: caller.name,
        fromAvatar: caller.avatar,
        offer: data.offer,
        callType: data.callType // 'audio' or 'video'
      });
    }
  });

  socket.on('answer-call', (data) => {
    const recipientSocketId = getSocketIdByEmail(data.recipientEmail);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call-answered', {
        answer: data.answer
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    const recipientSocketId = getSocketIdByEmail(data.recipientEmail);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('ice-candidate', {
        candidate: data.candidate
      });
    }
  });

  socket.on('end-call', (recipientEmail) => {
    const recipientSocketId = getSocketIdByEmail(recipientEmail);
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call-ended');
    }
  });

  // Отключение
  socket.on('disconnect', () => {
    const userEmail = onlineUsers.get(socket.id);
    if (userEmail) {
      const user = users.get(userEmail);
      
      // Уведомляем друзей
      if (user) {
        user.friends.forEach(friendEmail => {
          const friendSocketId = getSocketIdByEmail(friendEmail);
          if (friendSocketId) {
            io.to(friendSocketId).emit('friend-status', {
              email: userEmail,
              status: 'offline'
            });
          }
        });
      }
      
      onlineUsers.delete(socket.id);
    }
    console.log('🔴 Отключился:', socket.id);
  });
});

// Вспомогательные функции
function getSocketIdByEmail(email) {
  for (let [socketId, userEmail] of onlineUsers.entries()) {
    if (userEmail === email) return socketId;
  }
  return null;
}

function isUserOnline(email) {
  return Array.from(onlineUsers.values()).includes(email);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log('🚀 Sicore запущен на порту:', PORT);
});
