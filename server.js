const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const admin = require('firebase-admin');

// ========== CONFIGURATION ==========
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Initialiser Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json'); // ⚠️ À télécharger depuis Firebase Console

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://votre-projet.firebaseio.com" // ⚠️ Remplacer
});

const db = admin.database();

// ========== STOCKAGE EN MÉMOIRE ==========
const connectedUsers = new Map(); // userId -> { socketId, role, groupe, lat, lon, fcmToken }

// ========== FONCTIONS UTILITAIRES ==========

// Calculer la distance entre deux points (formule Haversine)
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371; // Rayon de la Terre en km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.asin(Math.sqrt(a));
    return R * c;
}

// Trouver les donneurs connectés correspondant aux critères
function findConnectedDonneurs(alertData) {
    const { groupe, latitude, longitude, rayon } = alertData;
    const results = [];

    connectedUsers.forEach((user, userId) => {
        if (user.role !== 'donneur') return;
        if (user.groupe !== groupe) return;
        
        const distance = haversine(latitude, longitude, user.lat, user.lon);
        
        if (distance <= rayon) {
            results.push({
                userId: userId,
                socketId: user.socketId,
                distance: distance.toFixed(1)
            });
            console.log(`✅ Donneur connecté trouvé : #${userId} (${distance.toFixed(1)} km)`);
        }
    });

    return results;
}

// Trouver les donneurs déconnectés dans Firebase
async function findOfflineDonneurs(alertData) {
    const { groupe, latitude, longitude, rayon } = alertData;
    const results = [];

    try {
        const snapshot = await db.ref('clients')
            .orderByChild('role')
            .equalTo('donneur')
            .once('value');

        snapshot.forEach(childSnapshot => {
            const userId = childSnapshot.key;
            const donneur = childSnapshot.val();

            // Ignorer si déjà connecté via Socket.IO
            if (connectedUsers.has(parseInt(userId))) {
                console.log(`⏭️ Donneur #${userId} déjà connecté, skip FCM`);
                return;
            }

            // Vérifier les critères
            if (donneur.groupe !== groupe) return;
            if (!donneur.latitude || !donneur.longitude) return;
            if (!donneur.fcmToken) return;

            const distance = haversine(
                latitude, longitude,
                donneur.latitude, donneur.longitude
            );

            if (distance <= rayon) {
                results.push({
                    userId: userId,
                    fcmToken: donneur.fcmToken,
                    distance: distance.toFixed(1),
                    name: donneur.name
                });
                console.log(`📱 Donneur OFFLINE trouvé : #${userId} (${distance.toFixed(1)} km)`);
            }
        });

    } catch (error) {
        console.error('❌ Erreur recherche donneurs offline :', error);
    }

    return results;
}

// Envoyer une notification FCM
async function sendFCM(token, alertData) {
    const message = {
        notification: {
            title: '🚨 Don de sang urgent - BloodLink',
            body: `Un don ${alertData.groupe} est nécessaire à ${alertData.zone} (${alertData.distance} km de vous)`
        },
        data: {
            alerteId: alertData.alerteId,
            medecinId: alertData.medecinId.toString(),
            zone: alertData.zone,
            groupe: alertData.groupe,
            distance: alertData.distance,
            type: 'blood_alert'
        },
        token: token,
        android: {
            priority: 'high',
            notification: {
                sound: 'default',
                channelId: 'blood_alerts'
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);
        console.log('✅ FCM envoyé avec succès :', response);
        return true;
    } catch (error) {
        console.error('❌ Erreur envoi FCM :', error);
        return false;
    }
}

// ========== GESTION DES CONNEXIONS SOCKET.IO ==========

io.on('connection', (socket) => {
    console.log(`🔌 Nouvelle connexion : ${socket.id}`);

    // ===== ENREGISTREMENT D'UN UTILISATEUR =====
    socket.on('register', async (data) => {
        const { userId, role, groupe, latitude, longitude } = data;

        console.log(`📝 Enregistrement : User #${userId} (${role})`);

        try {
            // Récupérer le token FCM depuis Firebase
            const userSnapshot = await db.ref(`clients/${userId}`).once('value');
            const userData = userSnapshot.val();
            const fcmToken = userData?.fcmToken || null;

            // Stocker en mémoire
            connectedUsers.set(userId, {
                socketId: socket.id,
                role: role,
                groupe: groupe || '',
                lat: latitude || 0,
                lon: longitude || 0,
                fcmToken: fcmToken
            });

            // Mettre à jour le statut de connexion dans Firebase
            await db.ref(`clients/${userId}`).update({
                connecte: true,
                lastSocketId: socket.id
            });

            socket.userId = userId;
            socket.emit('registered', { 
                success: true, 
                message: `Enregistré comme ${role}` 
            });

            console.log(`✅ User #${userId} enregistré : ${role} | Groupe: ${groupe}`);
            console.log(`   → Utilisateurs connectés : ${connectedUsers.size}`);

        } catch (error) {
            console.error('❌ Erreur enregistrement :', error);
            socket.emit('registered', { success: false, error: error.message });
        }
    });

    // ===== MISE À JOUR DE LA POSITION =====
    socket.on('updateLocation', (data) => {
        const { userId, latitude, longitude } = data;

        if (connectedUsers.has(userId)) {
            const user = connectedUsers.get(userId);
            user.lat = latitude;
            user.lon = longitude;
            connectedUsers.set(userId, user);

            // Mettre à jour Firebase (optionnel mais recommandé)
            db.ref(`clients/${userId}`).update({
                latitude: latitude,
                longitude: longitude
            });

            console.log(`📍 Position mise à jour : User #${userId} (${latitude}, ${longitude})`);
        }
    });

    // ===== ENVOI D'UNE ALERTE (SYSTÈME HYBRIDE) =====
    socket.on('sendAlert', async (data) => {
        const { medecinId, zone, groupe, rayon, latitude, longitude } = data;

        console.log('\n========== NOUVELLE ALERTE ==========');
        console.log(`Médecin #${medecinId} | Zone: ${zone} | Groupe: ${groupe} | Rayon: ${rayon} km`);

        // Générer un ID unique pour l'alerte
        const alerteId = `alert_${Date.now()}_${medecinId}`;

        const alertData = {
            alerteId: alerteId,
            medecinId: medecinId,
            zone: zone,
            groupe: groupe,
            rayon: rayon,
            latitude: latitude,
            longitude: longitude,
            timestamp: Date.now()
        };

        // Enregistrer l'alerte dans Firebase
        await db.ref(`alertes/${alerteId}`).set({
            ...alertData,
            statut: 'actif',
            date: new Date().toISOString()
        });

        let socketNotifications = 0;
        let fcmNotifications = 0;

        // ===== 1. ENVOYER VIA SOCKET.IO AUX CONNECTÉS =====
        const connectedDonneurs = findConnectedDonneurs(alertData);
        
        for (const donneur of connectedDonneurs) {
            io.to(donneur.socketId).emit('newAlert', {
                alerteId: alerteId,
                medecinId: medecinId,
                zone: zone,
                groupe: groupe,
                distance: donneur.distance
            });
            socketNotifications++;
            console.log(`🔔 Socket.IO → Donneur #${donneur.userId}`);
        }

        // ===== 2. ENVOYER VIA FCM AUX DÉCONNECTÉS =====
        const offlineDonneurs = await findOfflineDonneurs(alertData);
        
        for (const donneur of offlineDonneurs) {
            const sent = await sendFCM(donneur.fcmToken, {
                ...alertData,
                distance: donneur.distance
            });
            if (sent) fcmNotifications++;
        }

        // ===== CONFIRMATION AU MÉDECIN =====
        const totalNotifications = socketNotifications + fcmNotifications;
        
        socket.emit('alertSent', {
            alerteId: alerteId,
            notificationsSent: totalNotifications,
            socketNotifications: socketNotifications,
            fcmNotifications: fcmNotifications
        });

        console.log(`📊 Résultat : ${socketNotifications} Socket.IO + ${fcmNotifications} FCM = ${totalNotifications} total`);
        console.log('====================================\n');
    });

    // ===== RÉPONSE À UNE ALERTE =====
    socket.on('respondToAlert', async (data) => {
        const { alerteId, donneurId, medecinId, accepted } = data;

        console.log(`${accepted ? '✅' : '❌'} Réponse : Donneur #${donneurId} → Alerte ${alerteId}`);

        // Enregistrer la réponse dans Firebase
        await db.ref(`alertes_history`).push({
            alerte: alerteId,
            donneur: donneurId,
            medecin: medecinId,
            accepted: accepted,
            timestamp: Date.now()
        });

        // Notifier le médecin
        const medecinData = connectedUsers.get(medecinId);
        if (medecinData) {
            io.to(medecinData.socketId).emit('alertResponse', {
                alerteId: alerteId,
                donneurId: donneurId,
                accepted: accepted
            });
            console.log(`📤 Médecin #${medecinId} notifié de la réponse`);
        } else {
            // Si le médecin est déconnecté, envoyer FCM
            try {
                const medecinSnapshot = await db.ref(`clients/${medecinId}`).once('value');
                const medecinFcmToken = medecinSnapshot.val()?.fcmToken;
                
                if (medecinFcmToken) {
                    await admin.messaging().send({
                        notification: {
                            title: accepted ? '✅ Don accepté' : '❌ Don refusé',
                            body: `Un donneur a ${accepted ? 'accepté' : 'refusé'} votre alerte`
                        },
                        token: medecinFcmToken
                    });
                    console.log(`📱 FCM envoyé au médecin #${medecinId}`);
                }
            } catch (error) {
                console.error('❌ Erreur FCM médecin :', error);
            }
        }
    });

    // ===== DÉCONNEXION =====
    socket.on('disconnect', async () => {
        console.log(`🔌 Déconnexion : ${socket.id}`);

        if (socket.userId) {
            connectedUsers.delete(socket.userId);
            
            // Mettre à jour Firebase
            await db.ref(`clients/${socket.userId}`).update({
                connecte: false
            });

            console.log(`👋 User #${socket.userId} retiré (${connectedUsers.size} restants)`);
        }
    });
});

// ========== ROUTES API (OPTIONNELLES) ==========

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        connectedUsers: connectedUsers.size,
        timestamp: new Date().toISOString()
    });
});

app.get('/status', (req, res) => {
    const users = [];
    connectedUsers.forEach((user, userId) => {
        users.push({
            userId: userId,
            role: user.role,
            groupe: user.groupe
        });
    });
    
    res.json({
        connectedUsers: connectedUsers.size,
        users: users
    });
});

// ========== DÉMARRAGE DU SERVEUR ==========

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════╗');
    console.log('║   🩸 BloodLink Server Started 🩸   ║');
    console.log('╚════════════════════════════════════╝');
    console.log(`\n🌐 Serveur en écoute sur le port ${PORT}`);
    console.log(`🔗 URL: http://localhost:${PORT}\n`);
});
