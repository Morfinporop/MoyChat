const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const axios = require('axios');
const SMSRU_API_KEY = '646BAEF4-CCE6-01B5-6668-1D27927CC045';

app.use(express.static(__dirname));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

let users = new Map();
let chats = new Map();
let messages = new Map();
let smsCodes = new Map();

async function sendSMS_SMSRU(phone, code) {
    try {
        const response = await axios.get('https://sms.ru/sms/send', {
            params: {
                api_id: SMSRU_API_KEY,
                to: phone,
                msg: `Ваш код для входа в Sicore: ${code}`,
                json: 1
            }
        });
        return response.data.status === 'OK';
    } catch (error) {
        console.error('SMS.RU Error:', error);
        return false;
    }
}

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

app.post('/api/send-sms', async (req, res) => {
    const { phone } = req.body;

    if (!phone || phone.length < 11) {
        return res.json({ success: false, message: 'Некорректный номер телефона' });
    }

    const code = generateCode();
    
    smsCodes.set(phone, {
        code: code,
        expires: Date.now() + 5 * 60 * 1000
    });

    console.log(`📱 SMS код для ${phone}: ${code}`);
    const sent = true;

    if (sent) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Ошибка отправки SMS. Попробуйте позже.' });
    }
});

app.post('/api/verify-sms', (req, res) => {
    const { phone, code } = req.body;

    const savedCode = smsCodes.get(phone);

    if (!savedCode) {
        return res.json({ success: false, message: 'Код не найден. Запросите новый код.' });
    }

    if (Date.now() > savedCode.expires) {
        smsCodes.delete(phone);
        return res.json({ success: false, message: 'Код истек. Запросите новый код.' });
    }

    if (savedCode.code !== code) {
        return res.json({ success: false, message: 'Неверный код' });
    }

    smsCodes.delete(phone);

    let existingUser = null;
    for (let [id, user] of users.entries()) {
        if (user.phone === phone) {
            existingUser = user;
            break;
        }
    }

    res.json({ 
        success: true, 
        isNewUser: !existingUser 
    });
});

io.on('connection', (socket) => {
    console.log('🟢 Connected:', socket.id);

    socket.on('register', (data) => {
        const userId = socket.id;
        const user = {
            id: userId,
            name: data.name,
            lastname: data.lastname,
            phone: data.phone,
            avatar: null,
            bio: '',
            status: 'online',
            socketId: socket.id,
            lastSeen: Date.now(),
            twoFactorAuth: data.twoFactorAuth || false
        };
        
        users.set(userId, user);

        const allUsers = Array.from(users.values()).filter(u => u.id !== userId);
        const userChats = Array.from(chats.values())
            .filter(chat => chat.participants.includes(userId))
            .map(chat => {
                const otherUserId = chat.participants.find(id => id !== userId);
                const otherUser = users.get(otherUserId);
                
                return {
                    id: chat.id,
                    userId: otherUserId,
                    name: otherUser?.name || 'Пользователь',
                    avatar: otherUser?.avatar,
                    lastMessage: chat.lastMessage,
                    lastMessageTime: chat.lastMessageTime,
                    background: chat.background,
                    unread: 0,
                    messages: messages.get(chat.id) || []
                };
            });

        socket.emit('init', {
            user: user,
            chats: userChats,
            users: allUsers
        });

        socket.broadcast.emit('user-status', {
            userId: userId,
            status: 'online'
        });
    });

    socket.on('login', (data) => {
        let user = null;
        for (let [id, u] of users.entries()) {
            if (u.phone === data.phone) {
                user = u;
                user.id = socket.id;
                user.socketId = socket.id;
                user.status = 'online';
                users.set(socket.id, user);
                break;
            }
        }

        if (user) {
            const allUsers = Array.from(users.values()).filter(u => u.id !== user.id);
            const userChats = Array.from(chats.values())
                .filter(chat => chat.participants.includes(user.id))
                .map(chat => {
                    const otherUserId = chat.participants.find(id => id !== user.id);
                    const otherUser = users.get(otherUserId);
                    
                    return {
                        id: chat.id,
                        userId: otherUserId,
                        name: otherUser?.name || 'Пользователь',
                        avatar: otherUser?.avatar,
                        lastMessage: chat.lastMessage,
                        lastMessageTime: chat.lastMessageTime,
                        background: chat.background,
                        messages: messages.get(chat.id) || []
                    };
                });

            socket.emit('init', {
                user: user,
                chats: userChats,
                users: allUsers
            });

            socket.broadcast.emit('user-status', {
                userId: user.id,
                status: 'online'
            });
        }
    });

    socket.on('send-message', (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        const message = {
            id: Date.now(),
            from: user.id,
            text: data.text || null,
            image: data.image || null,
            timestamp: Date.now()
        };

        if (!messages.has(data.chatId)) {
            messages.set(data.chatId, []);
        }
        messages.get(data.chatId).push(message);

        const chat = chats.get(data.chatId);
        if (chat) {
            chat.lastMessage = data.text || 'Изображение';
            chat.lastMessageTime = Date.now();

            chat.participants.forEach(participantId => {
                const participant = users.get(participantId);
                if (participant) {
                    io.to(participant.socketId).emit('new-message', {
                        chatId: data.chatId,
                        message: message
                    });
                }
            });
        }
    });

    socket.on('create-chat', (userId) => {
        const currentUser = users.get(socket.id);
        const targetUser = users.get(userId);
        
        if (!currentUser || !targetUser) return;

        let existingChat = null;
        for (let [chatId, chat] of chats.entries()) {
            if (chat.participants.includes(currentUser.id) && chat.participants.includes(targetUser.id)) {
                existingChat = chat;
                break;
            }
        }

        if (existingChat) {
            socket.emit('chat-created', {
                id: existingChat.id,
                userId: targetUser.id,
                name: targetUser.name,
                avatar: targetUser.avatar,
                lastMessage: existingChat.lastMessage,
                lastMessageTime: existingChat.lastMessageTime,
                background: existingChat.background,
                messages: messages.get(existingChat.id) || []
            });
            return;
        }

        const chatId = `chat-${Date.now()}`;
        const newChat = {
            id: chatId,
            participants: [currentUser.id, targetUser.id],
            createdAt: Date.now(),
            lastMessage: null,
            lastMessageTime: null,
            background: null
        };

        chats.set(chatId, newChat);
        messages.set(chatId, []);

        [currentUser, targetUser].forEach(user => {
            const otherUser = user.id === currentUser.id ? targetUser : currentUser;
            io.to(user.socketId).emit('chat-created', {
                id: chatId,
                userId: otherUser.id,
                name: otherUser.name,
                avatar: otherUser.avatar,
                lastMessage: null,
                lastMessageTime: null,
                background: null,
                messages: []
            });
        });
    });

    socket.on('update-avatar', (avatar) => {
        const user = users.get(socket.id);
        if (user) {
            user.avatar = avatar;
            io.emit('user-updated', {
                userId: user.id,
                avatar: avatar
            });
        }
    });

    socket.on('update-profile', (data) => {
        const user = users.get(socket.id);
        if (user) {
            user.name = data.name;
            user.bio = data.bio || '';
            
            io.emit('user-updated', {
                userId: user.id,
                name: data.name
            });
        }
    });

    socket.on('toggle-2fa', (enabled) => {
        const user = users.get(socket.id);
        if (user) {
            user.twoFactorAuth = enabled;
        }
    });

    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            user.status = 'offline';
            user.lastSeen = Date.now();
            
            socket.broadcast.emit('user-status', {
                userId: user.id,
                status: 'offline'
            });
        }
        console.log('🔴 Disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log('🚀 Server running on port:', PORT);
    console.log(`📱 http://localhost:${PORT}`);
});
