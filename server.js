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
        console.log(`📤 Отправка SMS на номер: ${phone}`);
        console.log(`📝 Код: ${code}`);
        
        let formattedPhone = phone.replace(/\D/g, '');
        
        if (formattedPhone.startsWith('8')) {
            formattedPhone = '7' + formattedPhone.slice(1);
        }
        
        console.log(`📞 Отформатированный номер: ${formattedPhone}`);
        
        // ИСПОЛЬЗУЕМ СТАНДАРТНОГО ОТПРАВИТЕЛЯ (уже подключен ко всем операторам)
        const response = await axios.get('https://sms.ru/sms/send', {
            params: {
                api_id: SMSRU_API_KEY,
                to: formattedPhone,
                msg: `Код Sicore: ${code}`,
                // НЕ УКАЗЫВАЕМ from - будет использован отправитель по умолчанию от SMS.RU
                json: 1
            },
            timeout: 10000
        });
        
        console.log('📥 Ответ от SMS.RU:', JSON.stringify(response.data, null, 2));
        
        // ИСПРАВЛЕННАЯ ПРОВЕРКА СТАТУСА
        if (response.data && response.data.status === 'OK') {
            const smsStatus = response.data.sms && response.data.sms[formattedPhone];
            
            if (smsStatus) {
                if (smsStatus.status === 'OK') {
                    console.log('✅ SMS успешно отправлено!');
                    console.log(`✉️  ID сообщения: ${smsStatus.sms_id}`);
                    return true;
                } else if (smsStatus.status === 'ERROR') {
                    console.error(`❌ Ошибка отправки SMS: ${smsStatus.status_text}`);
                    console.error(`❌ Код ошибки: ${smsStatus.status_code}`);
                    return false;
                }
            }
        }
        
        console.error('❌ Неожиданный ответ от сервера');
        return false;
        
    } catch (error) {
        console.error('❌ Критическая ошибка при отправке SMS:', error.message);
        if (error.response) {
            console.error('📥 Ответ сервера:', error.response.data);
        }
        return false;
    }
}

function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

app.post('/api/send-sms', async (req, res) => {
    const { phone } = req.body;

    console.log('📲 Получен запрос на отправку SMS для номера:', phone);

    if (!phone || phone.length < 11) {
        console.log('❌ Некорректный номер телефона');
        return res.json({ success: false, message: 'Некорректный номер телефона' });
    }

    const code = generateCode();
    
    smsCodes.set(phone, {
        code: code,
        expires: Date.now() + 5 * 60 * 1000
    });

    console.log(`💾 Код сохранен: ${code} для номера ${phone}`);
    
    const sent = await sendSMS_SMSRU(phone, code);
    
    if (!sent) {
        console.log('⚠️ SMS не отправлена');
        console.log(`🔑 ТЕСТОВЫЙ КОД (смотрите в консоли): ${code}`);
        
        // ВРЕМЕННО: Разрешаем продолжить даже если SMS не отправлена (для тестирования)
        return res.json({ 
            success: true,
            testMode: true,
            message: 'Тестовый режим активен. Код: ' + code
        });
    }

    console.log('✅ SMS отправлена успешно');
    res.json({ success: true });
});

app.post('/api/verify-sms', (req, res) => {
    const { phone, code } = req.body;

    console.log(`🔍 Проверка кода ${code} для номера ${phone}`);

    const savedCode = smsCodes.get(phone);

    if (!savedCode) {
        console.log('❌ Код не найден в базе');
        return res.json({ success: false, message: 'Код не найден. Запросите новый код.' });
    }

    if (Date.now() > savedCode.expires) {
        console.log('❌ Код истек');
        smsCodes.delete(phone);
        return res.json({ success: false, message: 'Код истек. Запросите новый код.' });
    }

    if (savedCode.code !== code) {
        console.log(`❌ Неверный код. Ожидался: ${savedCode.code}, получен: ${code}`);
        return res.json({ success: false, message: 'Неверный код' });
    }

    console.log('✅ Код верный!');
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

app.get('/api/check-sms-balance', async (req, res) => {
    try {
        const response = await axios.get('https://sms.ru/my/balance', {
            params: {
                api_id: SMSRU_API_KEY,
                json: 1
            }
        });
        
        console.log('💰 Баланс SMS.RU:', response.data);
        res.json(response.data);
    } catch (error) {
        console.error('❌ Ошибка проверки баланса:', error.message);
        res.json({ error: error.message });
    }
});

// Новый endpoint для проверки отправителей
app.get('/api/check-senders', async (req, res) => {
    try {
        const response = await axios.get('https://sms.ru/senders', {
            params: {
                api_id: SMSRU_API_KEY,
                json: 1
            }
        });
        
        console.log('📋 Отправители:', response.data);
        res.json(response.data);
    } catch (error) {
        console.error('❌ Ошибка проверки отправителей:', error.message);
        res.json({ error: error.message });
    }
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
    console.log('');
    console.log('📋 Проверка настроек:');
    console.log(`   Баланс: http://localhost:${PORT}/api/check-sms-balance`);
    console.log(`   Отправители: http://localhost:${PORT}/api/check-senders`);
    console.log('');
    console.log('⚠️  ВРЕМЕННО ВКЛЮЧЕН ТЕСТОВЫЙ РЕЖИМ');
    console.log('   Коды будут показываться в консоли');
    console.log('');
});
