const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const nodemailer = require('nodemailer');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

app.use(express.static(__dirname));
app.use(express.json());

// База данных (сохраняется в файл)
const adapter = new FileSync('db.json');
const db = low(adapter);

// Инициализация БД
db.defaults({ 
    users: [], 
    chats: [], 
    messages: [],
    emailCodes: []
}).write();

// ==================== EMAIL SETUP ====================
// НАСТРОЙКА GMAIL:
// 1. Зайдите в Google Account: https://myaccount.google.com/
// 2. Безопасность → Двухэтапная аутентификация → ВКЛЮЧИТЕ
// 3. Пароли приложений → Выберите "Почта" и "Другое устройство"
// 4. Скопируйте сгенерированный пароль (16 символов)
// 5. Вставьте ниже

const EMAIL_USER = 'kirillploskin471@gmail.com';  // ← ВАША ПОЧТА GMAIL
const EMAIL_PASS = 'acjp aomn yocd wcee';   // ← ПАРОЛЬ ПРИЛОЖЕНИЯ (16 символов)

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
    }
});

// Проверка подключения к email при старте
transporter.verify((error, success) => {
    if (error) {
        console.error('❌ Email не настроен:', error.message);
        console.log('');
        console.log('⚠️  НАСТРОЙТЕ EMAIL:');
        console.log('   1. Зайдите на https://myaccount.google.com/');
        console.log('   2. Безопасность → Двухэтапная аутентификация');
        console.log('   3. Пароли приложений → Создать');
        console.log('   4. Вставьте в server.js');
        console.log('');
    } else {
        console.log('✅ Email готов к отправке');
    }
});

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Отправка кода на email
app.post('/api/send-email-code', async (req, res) => {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
        return res.json({ success: false, message: 'Некорректный email' });
    }

    const code = generateCode();
    
    // Сохраняем код в БД
    db.get('emailCodes')
        .push({
            email: email,
            code: code,
            expires: Date.now() + 10 * 60 * 1000 // 10 минут
        })
        .write();

    // Очищаем старые коды
    db.set('emailCodes', db.get('emailCodes').filter(c => c.expires > Date.now()).value()).write();

    console.log(`📧 Отправка кода на ${email}: ${code}`);

    try {
        await transporter.sendMail({
            from: `"Sicore" <${EMAIL_USER}>`,
            to: email,
            subject: 'Код подтверждения Sicore',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="background: linear-gradient(135deg, #3d2e26 0%, #6b5449 100%); padding: 30px; border-radius: 10px; text-align: center;">
                        <h1 style="color: #f5f1ed; margin: 0;">☕ Sicore</h1>
                        <p style="color: #b8956a; margin: 5px 0;">Безопасный мессенджер</p>
                    </div>
                    <div style="background: #f5f1ed; padding: 30px; border-radius: 10px; margin-top: 20px;">
                        <h2 style="color: #3d2e26;">Ваш код подтверждения:</h2>
                        <div style="background: #3d2e26; color: #f5f1ed; font-size: 32px; font-weight: bold; padding: 20px; border-radius: 10px; text-align: center; letter-spacing: 5px; margin: 20px 0;">
                            ${code}
                        </div>
                        <p style="color: #6b5449; font-size: 14px;">Код действителен 10 минут</p>
                        <p style="color: #6b5449; font-size: 14px;">Если вы не запрашивали этот код, просто проигнорируйте это письмо.</p>
                    </div>
                </div>
            `
        });

        console.log('✅ Email отправлен');
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка отправки email:', error);
        res.json({ 
            success: false, 
            message: 'Ошибка отправки email. Проверьте настройки в server.js'
        });
    }
});

// Проверка кода
app.post('/api/verify-email-code', (req, res) => {
    const { email, code } = req.body;

    const savedCode = db.get('emailCodes')
        .find({ email: email, code: code })
        .value();

    if (!savedCode) {
        return res.json({ success: false, message: 'Неверный код' });
    }

    if (Date.now() > savedCode.expires) {
        db.get('emailCodes').remove({ email: email }).write();
        return res.json({ success: false, message: 'Код истек' });
    }

    // Удаляем использованный код
    db.get('emailCodes').remove({ email: email }).write();

    // Проверяем существование пользователя
    const existingUser = db.get('users').find({ email: email }).value();

    res.json({ 
        success: true, 
        isNewUser: !existingUser 
    });
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ==================== SOCKET.IO ====================
const onlineUsers = new Map(); // socketId -> userId

io.on('connection', (socket) => {
    console.log('🟢 Connected:', socket.id);

    // Регистрация
    socket.on('register', (data) => {
        const userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        const user = {
            id: userId,
            name: data.name,
            lastname: data.lastname || '',
            email: data.email,
            avatar: null,
            bio: '',
            status: 'online',
            lastSeen: Date.now(),
            twoFactorAuth: data.twoFactorAuth || false,
            privacy: {
                showPhone: 'everyone',
                showLastSeen: true,
                showPhoto: 'everyone',
                whoCanMessage: 'everyone',
                showBio: 'everyone'
            },
            blockedUsers: [],
            createdAt: Date.now()
        };
        
        db.get('users').push(user).write();
        onlineUsers.set(socket.id, userId);

        // Создаем чат с ботом
        const botChat = {
            id: 'chat_bot_' + userId,
            participants: ['sicore_bot', userId],
            createdAt: Date.now(),
            lastMessage: `Добро пожаловать, ${data.name}!`,
            lastMessageTime: Date.now(),
            background: null,
            pinned: false,
            muted: false
        };
        db.get('chats').push(botChat).write();

        // Приветственное сообщение от бота
        const welcomeMsg = {
            id: 'msg_' + Date.now(),
            chatId: botChat.id,
            from: 'sicore_bot',
            text: `Добро пожаловать, ${data.name}!\n\n🎉 Спасибо за регистрацию в Sicore!\n\n✨ Основные возможности:\n• Безопасные чаты\n• Отправка фото и GIF\n• Полная приватность\n• Без блокировок\n\nНачните общение с друзьями!`,
            timestamp: Date.now(),
            image: null
        };
        db.get('messages').push(welcomeMsg).write();

        sendInitData(socket, userId);
        broadcastUserStatus(userId, 'online');
    });

    // Логин
    socket.on('login', (data) => {
        const user = db.get('users').find({ email: data.email }).value();
        
        if (user) {
            user.status = 'online';
            user.lastSeen = Date.now();
            db.get('users').find({ id: user.id }).assign(user).write();
            
            onlineUsers.set(socket.id, user.id);
            sendInitData(socket, user.id);
            broadcastUserStatus(user.id, 'online');
        }
    });

    // Отправка сообщения
    socket.on('send-message', (data) => {
        const userId = onlineUsers.get(socket.id);
        if (!userId) return;

        const message = {
            id: 'msg_' + Date.now(),
            chatId: data.chatId,
            from: userId,
            text: data.text || null,
            image: data.image || null,
            timestamp: Date.now()
        };

        db.get('messages').push(message).write();

        const chat = db.get('chats').find({ id: data.chatId }).value();
        if (chat) {
            chat.lastMessage = data.text || 'Изображение';
            chat.lastMessageTime = Date.now();
            db.get('chats').find({ id: data.chatId }).assign(chat).write();

            // Отправляем обоим участникам
            chat.participants.forEach(participantId => {
                const participantSocket = getSocketByUserId(participantId);
                if (participantSocket) {
                    io.to(participantSocket).emit('new-message', {
                        chatId: data.chatId,
                        message: message
                    });
                    io.to(participantSocket).emit('chat-updated', chat);
                }
            });

            // Звук уведомления
            const recipient = chat.participants.find(p => p !== userId);
            const recipientSocket = getSocketByUserId(recipient);
            if (recipientSocket && !chat.muted) {
                io.to(recipientSocket).emit('notification-sound');
            }
        }
    });

    // Создание чата
    socket.on('create-chat', (targetUserId) => {
        const userId = onlineUsers.get(socket.id);
        if (!userId) return;

        // Проверяем блокировку
        const currentUser = db.get('users').find({ id: userId }).value();
        const targetUser = db.get('users').find({ id: targetUserId }).value();
        
        if (currentUser.blockedUsers.includes(targetUserId) || 
            targetUser.blockedUsers.includes(userId)) {
            return;
        }

        // Проверяем настройки приватности
        if (targetUser.privacy.whoCanMessage === 'nobody' && targetUserId !== 'sicore_bot') {
            socket.emit('chat-restricted', { userId: targetUserId });
            return;
        }

        // Проверяем существующий чат
        let existingChat = db.get('chats')
            .find(c => c.participants.includes(userId) && c.participants.includes(targetUserId))
            .value();

        if (existingChat) {
            socket.emit('chat-created', formatChat(existingChat, userId));
            return;
        }

        // Создаем новый чат
        const chatId = 'chat_' + Date.now();
        const newChat = {
            id: chatId,
            participants: [userId, targetUserId],
            createdAt: Date.now(),
            lastMessage: null,
            lastMessageTime: Date.now(),
            background: null,
            pinned: false,
            muted: false
        };

        db.get('chats').push(newChat).write();

        // Отправляем только инициатору (не создаем чат у второго пользователя автоматически)
        socket.emit('chat-created', formatChat(newChat, userId));
    });

    // Обновление профиля
    socket.on('update-profile', (data) => {
        const userId = onlineUsers.get(socket.id);
        if (!userId) return;

        const user = db.get('users').find({ id: userId }).value();
        if (data.name) user.name = data.name;
        if (data.lastname !== undefined) user.lastname = data.lastname;
        if (data.bio !== undefined) user.bio = data.bio;
        if (data.avatar !== undefined) user.avatar = data.avatar;
        
        db.get('users').find({ id: userId }).assign(user).write();

        // Уведомляем всех о изменении
        io.emit('user-updated', {
            userId: userId,
            name: user.name,
            lastname: user.lastname,
            avatar: user.avatar,
            bio: user.bio
        });
    });

    // Обновление приватности
    socket.on('update-privacy', (data) => {
        const userId = onlineUsers.get(socket.id);
        if (!userId) return;

        const user = db.get('users').find({ id: userId }).value();
        user.privacy = { ...user.privacy, ...data };
        db.get('users').find({ id: userId }).assign(user).write();
    });

    // Блокировка/разблокировка
    socket.on('block-user', (targetUserId) => {
        const userId = onlineUsers.get(socket.id);
        if (!userId || targetUserId === 'sicore_bot') return;

        const user = db.get('users').find({ id: userId }).value();
        if (!user.blockedUsers.includes(targetUserId)) {
            user.blockedUsers.push(targetUserId);
            db.get('users').find({ id: userId }).assign(user).write();
        }
    });

    socket.on('unblock-user', (targetUserId) => {
        const userId = onlineUsers.get(socket.id);
        if (!userId) return;

        const user = db.get('users').find({ id: userId }).value();
        user.blockedUsers = user.blockedUsers.filter(id => id !== targetUserId);
        db.get('users').find({ id: userId }).assign(user).write();
    });

    // Закрепление чата
    socket.on('pin-chat', (chatId) => {
        const chat = db.get('chats').find({ id: chatId }).value();
        if (chat) {
            chat.pinned = !chat.pinned;
            db.get('chats').find({ id: chatId }).assign(chat).write();
            socket.emit('chat-updated', chat);
        }
    });

    // Мут чата
    socket.on('mute-chat', (chatId) => {
        const chat = db.get('chats').find({ id: chatId }).value();
        if (chat) {
            chat.muted = !chat.muted;
            db.get('chats').find({ id: chatId }).assign(chat).write();
            socket.emit('chat-updated', chat);
        }
    });

    // Удаление чата
    socket.on('delete-chat', (data) => {
        const userId = onlineUsers.get(socket.id);
        const chat = db.get('chats').find({ id: data.chatId }).value();
        
        if (!chat) return;

        if (data.forEveryone) {
            // Удалить для всех
            db.get('chats').remove({ id: data.chatId }).write();
            db.get('messages').remove({ chatId: data.chatId }).write();
            
            chat.participants.forEach(participantId => {
                const participantSocket = getSocketByUserId(participantId);
                if (participantSocket) {
                    io.to(participantSocket).emit('chat-deleted', data.chatId);
                }
            });
        } else {
            // Удалить только для себя
            // TODO: Реализовать логику удаления только для одного пользователя
            socket.emit('chat-deleted', data.chatId);
        }
    });

    // Удаление аккаунта
    socket.on('delete-account', () => {
        const userId = onlineUsers.get(socket.id);
        if (!userId) return;

        // Удаляем все чаты пользователя
        const userChats = db.get('chats').filter(c => c.participants.includes(userId)).value();
        userChats.forEach(chat => {
            db.get('messages').remove({ chatId: chat.id }).write();
        });
        db.get('chats').remove(c => c.participants.includes(userId)).write();

        // Удаляем пользователя
        db.get('users').remove({ id: userId }).write();
        
        onlineUsers.delete(socket.id);
        socket.emit('account-deleted');
    });

    // Фон чата
    socket.on('set-chat-background', (data) => {
        const chat = db.get('chats').find({ id: data.chatId }).value();
        if (chat) {
            chat.background = data.background;
            db.get('chats').find({ id: data.chatId }).assign(chat).write();
        }
    });

    // Отключение
    socket.on('disconnect', () => {
        const userId = onlineUsers.get(socket.id);
        if (userId && userId !== 'sicore_bot') {
            const user = db.get('users').find({ id: userId }).value();
            if (user) {
                user.status = 'offline';
                user.lastSeen = Date.now();
                db.get('users').find({ id: userId }).assign(user).write();
                
                broadcastUserStatus(userId, 'offline');
            }
            onlineUsers.delete(socket.id);
        }
        console.log('🔴 Disconnected:', socket.id);
    });
});

// Вспомогательные функции
function sendInitData(socket, userId) {
    const user = db.get('users').find({ id: userId }).value();
    const userChats = db.get('chats')
        .filter(c => c.participants.includes(userId))
        .value()
        .map(chat => formatChat(chat, userId));

    const allUsers = db.get('users')
        .reject({ id: userId })
        .value()
        .map(u => formatUser(u, user));

    socket.emit('init', {
        user: user,
        chats: userChats,
        users: allUsers
    });
}

function formatChat(chat, currentUserId) {
    const otherUserId = chat.participants.find(id => id !== currentUserId);
    let otherUser;
    
    if (otherUserId === 'sicore_bot') {
        otherUser = {
            id: 'sicore_bot',
            name: 'Sicore',
            lastname: 'Bot',
            avatar: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcS4noFv9j8OCSQBmThkRcw0HZTn6WJDJ4rYCw&s',
            status: 'online',
            bio: 'Официальный бот Sicore'
        };
    } else {
        otherUser = db.get('users').find({ id: otherUserId }).value();
    }

    const messages = db.get('messages')
        .filter({ chatId: chat.id })
        .value();

    return {
        ...chat,
        userId: otherUserId,
        name: otherUser ? `${otherUser.name} ${otherUser.lastname}`.trim() : 'Пользователь',
        avatar: otherUser?.avatar,
        status: otherUser?.status || 'offline',
        lastSeen: otherUser?.lastSeen,
        messages: messages,
        isBot: otherUserId === 'sicore_bot'
    };
}

function formatUser(user, currentUser) {
    const formatted = {
        id: user.id,
        name: user.name,
        lastname: user.lastname,
        status: user.status,
        lastSeen: user.lastSeen
    };

    // Применяем настройки приватности
    if (user.privacy.showPhoto === 'nobody' || 
        (user.privacy.showPhoto === 'contacts' && !currentUser)) {
        formatted.avatar = null;
    } else {
        formatted.avatar = user.avatar;
    }

    if (user.privacy.showBio === 'nobody' ||
        (user.privacy.showBio === 'contacts' && !currentUser)) {
        formatted.bio = '';
    } else {
        formatted.bio = user.bio;
    }

    formatted.canMessage = user.privacy.whoCanMessage === 'everyone';
    formatted.isBlocked = currentUser?.blockedUsers?.includes(user.id);

    return formatted;
}

function getSocketByUserId(userId) {
    for (let [socketId, uId] of onlineUsers.entries()) {
        if (uId === userId) return socketId;
    }
    return null;
}

function broadcastUserStatus(userId, status) {
    io.emit('user-status', {
        userId: userId,
        status: status,
        lastSeen: Date.now()
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log('🚀 Sicore Messenger');
    console.log(`📱 http://localhost:${PORT}`);
    console.log('');
    console.log('📧 Настройте Gmail для отправки кодов:');
    console.log('   1. https://myaccount.google.com/security');
    console.log('   2. Двухэтапная аутентификация → Включить');
    console.log('   3. Пароли приложений → Создать');
    console.log('   4. Вставьте в server.js (EMAIL_USER и EMAIL_PASS)');
    console.log('');
});
