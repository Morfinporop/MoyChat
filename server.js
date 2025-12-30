const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ==================== SMS PROVIDER SETUP ====================
// Выберите один из сервисов:

// 1. SMSC.RU (Россия)
const axios = require('axios');
const SMSC_LOGIN = 'your_login';  // Замените на ваш логин
const SMSC_PASSWORD = 'your_password';  // Замените на ваш пароль

// 2. SMS.RU (Россия)
const SMSRU_API_KEY = '4C35F484-3D28-97BB-0359-D16DDC5EB1F2';  // Замените на ваш API ключ

// 3. TWILIO (Международный)
const TWILIO_ACCOUNT_SID = 'your_account_sid';
const TWILIO_AUTH_TOKEN = 'your_auth_token';
const TWILIO_PHONE = 'your_twilio_phone';

app.use(express.static(__dirname));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Database
let users = new Map();
let chats = new Map();
let messages = new Map();
let smsCodes = new Map(); // phone -> {code, expires}

// ==================== SMS API ====================

// ВАРИАНТ 1: SMSC.RU
async function sendSMS_SMSC(phone, code) {
    try {
        const response = await axios.get('https://smsc.ru/sys/send.php', {
            params: {
                login: SMSC_LOGIN,
                psw: SMSC_PASSWORD,
                phones: phone,
                mes: `Ваш код для входа в Sicore: ${code}`,
                charset: 'utf-8'
            }
        });
        return response.data.error ? false : true;
    } catch (error) {
        console.error('SMSC Error:', error);
        return false;
    }
}

// ВАРИАНТ 2: SMS.RU
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

// ВАРИАНТ 3: TWILIO
const twilio = require('twilio');
async function sendSMS_TWILIO(phone, code) {
    try {
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        await client.messages.create({
            body: `Ваш код для входа в Sicore: ${code}`,
            from: TWILIO_PHONE,
            to: phone
        });
        return true;
    } catch (error) {
        console.error('Twilio Error:', error);
        return false;
    }
}

// Generate 4-digit code
function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// Send SMS endpoint
app.post('/api/send-sms', async (req, res) => {
    const { phone } = req.body;

    if (!phone || phone.length < 11) {
        return res.json({ success: false, message: 'Некорректный номер телефона' });
    }

    const code = generateCode();
    
    // Save code with 5 min expiration
    smsCodes.set(phone, {
        code: code,
        expires: Date.now() + 5 * 60 * 1000
    });

    // Выберите нужный сервис:
    // const sent = await sendSMS_SMSC(phone, code);
    // const sent = await sendSMS_SMSRU(phone, code);
    // const sent = await sendSMS_TWILIO(phone, code);

    // ДЛЯ ТЕСТИРОВАНИЯ (убрать в продакшене):
    console.log(`📱 SMS код для ${phone}: ${code}`);
    const sent = true;

    if (sent) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Ошибка отправки SMS. Попробуйте позже.' });
    }
});

// Verify SMS code
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

    // Check if user exists
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

// ==================== SOCKET ====================
io.on('connection', (socket) => {
    console.log('🟢 User connected:', socket.id);

    socket.on('register', (data) => {
        const userId = socket.id;
        const user = {
            id: userId,
            name: data.name,
            phone: data.phone,
            avatar: null,
            bio: '',
            status: 'online',
            socketId: socket.id,
            lastSeen: Date.now()
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
                        messages: messages.get(chat.id) || []
                    };
                });

            socket.emit('init', {
                user: user,
                chats: userChats,
                users: allUsers
            });
        }
    });

    socket.on('send-message', (data) => {
        const user = users.get(socket.id);
        if (!user) return;

        const message = {
            id: Date.now(),
            from: user.id,
            text: data.text,
            timestamp: Date.now()
        };

        if (!messages.has(data.chatId)) {
            messages.set(data.chatId, []);
        }
        messages.get(data.chatId).push(message);

        const chat = chats.get(data.chatId);
        if (chat) {
            chat.lastMessage = data.text;
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
            lastMessageTime: null
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
        console.log('🔴 User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log('🚀 Server running on port:', PORT);
    console.log(`📱 http://localhost:${PORT}`);
});
