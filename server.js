const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

// База данных
let users = new Map();
let friendRequests = new Map();
let messages = new Map();

io.on('connection', (socket) => {
    console.log('🟢 Подключился:', socket.id);

    socket.on('register', (data) => {
        const user = {
            id: socket.id,
            username: data.username || data.name,
            email: data.email,
            status: 'online',
            friends: [],
            socketId: socket.id
        };
        
        users.set(socket.id, user);
        
        socket.emit('init', {
            user: user,
            friends: [],
            friendRequests: []
        });
    });

    socket.on('send-friend-request', (username) => {
        const sender = users.get(socket.id);
        let recipient = null;
        
        for (let [id, user] of users.entries()) {
            if (user.username === username) {
                recipient = user;
                break;
            }
        }
        
        if (recipient) {
            if (!friendRequests.has(recipient.id)) {
                friendRequests.set(recipient.id, []);
            }
            friendRequests.get(recipient.id).push({
                id: sender.id,
                username: sender.username
            });
            
            io.to(recipient.socketId).emit('friend-request', {
                id: sender.id,
                username: sender.username
            });
        }
    });

    socket.on('accept-friend', (userId) => {
        const user = users.get(socket.id);
        const friend = users.get(userId);
        
        if (user && friend) {
            user.friends.push(userId);
            friend.friends.push(socket.id);
            
            socket.emit('friend-added', {
                id: friend.id,
                username: friend.username,
                status: friend.status
            });
            
            io.to(friend.socketId).emit('friend-added', {
                id: user.id,
                username: user.username,
                status: user.status
            });
        }
    });

    socket.on('send-message', (data) => {
        const user = users.get(socket.id);
        if (!user) return;
        
        const msg = {
            id: Date.now(),
            channelId: data.channelId,
            author: user.username,
            text: data.text,
            time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
            pinned: false
        };
        
        if (!messages.has(data.channelId)) {
            messages.set(data.channelId, []);
        }
        messages.get(data.channelId).push(msg);
        
        // Отправка собеседнику
        const friendId = data.channelId.replace('dm-', '');
        io.to(friendId).emit('message', msg);
        socket.emit('message', msg);
    });

    socket.on('start-call', (data) => {
        io.to(data.friendId).emit('call-incoming', {
            from: socket.id,
            type: data.type
        });
    });

    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            user.status = 'offline';
        }
        console.log('🔴 Отключился:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log('🚀 Сервер запущен на порту:', PORT);
});
