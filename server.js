const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Stocker les utilisateurs connectés
const users = new Map(); // userId -> socketId
const donneurs = new Map(); // userId -> {groupe, lat, lon, socketId}

// Connexion d'un client
io.on('connection', (socket) => {
  console.log('✅ Nouvel utilisateur connecté:', socket.id);

  // Enregistrer un utilisateur
  socket.on('register', (data) => {
    const { userId, role, groupe, latitude, longitude } = data;
    
    users.set(userId, socket.id);
    
    if (role === 'donneur') {
      donneurs.set(userId, {
        socketId: socket.id,
        groupe: groupe,
        latitude: latitude,
        longitude: longitude,
        connecte: true
      });
      console.log(`👤 Donneur ${userId} enregistré - Groupe: ${groupe}`);
    }
    
    socket.userId = userId;
    socket.role = role;
    
    socket.emit('registered', { success: true, userId: userId });
  });

  // Mettre à jour la position d'un donneur
  socket.on('updateLocation', (data) => {
    const { userId, latitude, longitude } = data;
    
    if (donneurs.has(userId)) {
      const donneur = donneurs.get(userId);
      donneur.latitude = latitude;
      donneur.longitude = longitude;
      donneur.lastUpdate = Date.now();
      donneurs.set(userId, donneur);
      
      console.log(`📍 Position mise à jour pour donneur ${userId}`);
    }
  });

  // Envoyer une alerte
  socket.on('sendAlert', (data) => {
    const { 
      medecinId, 
      zone, 
      groupe, 
      rayon, 
      latitude, 
      longitude 
    } = data;
    
    console.log(`🚨 Nouvelle alerte de médecin ${medecinId}`);
    console.log(`   Zone: ${zone}, Groupe: ${groupe}, Rayon: ${rayon}km`);
    
    let notificationsSent = 0;
    const alerteId = `alerte_${Date.now()}`;
    
    // Trouver les donneurs éligibles
    donneurs.forEach((donneur, donneurId) => {
      // Vérifier le groupe sanguin
      if (donneur.groupe !== groupe) {
        return;
      }
      
      // Calculer la distance
      const distance = haversine(
        latitude, 
        longitude, 
        donneur.latitude, 
        donneur.longitude
      );
      
      console.log(`   Donneur ${donneurId}: ${distance.toFixed(2)}km`);
      
      if (distance <= rayon && donneur.connecte) {
        // Envoyer la notification au donneur
        io.to(donneur.socketId).emit('newAlert', {
          alerteId: alerteId,
          medecinId: medecinId,
          zone: zone,
          groupe: groupe,
          distance: distance.toFixed(1),
          latitude: latitude,
          longitude: longitude
        });
        
        notificationsSent++;
        console.log(`   ✅ Notification envoyée à donneur ${donneurId}`);
      }
    });
    
    // Confirmer au médecin
    socket.emit('alertSent', {
      success: true,
      alerteId: alerteId,
      notificationsSent: notificationsSent
    });
    
    console.log(`📊 ${notificationsSent} notifications envoyées`);
  });

  // Accepter/Refuser une alerte
  socket.on('respondToAlert', (data) => {
    const { alerteId, donneurId, medecinId, accepted } = data;
    
    console.log(`${accepted ? '✅' : '❌'} Donneur ${donneurId} a ${accepted ? 'accepté' : 'refusé'} l'alerte ${alerteId}`);
    
    // Notifier le médecin
    const medecinSocketId = users.get(medecinId);
    if (medecinSocketId) {
      io.to(medecinSocketId).emit('alertResponse', {
        alerteId: alerteId,
        donneurId: donneurId,
        accepted: accepted,
        timestamp: Date.now()
      });
    }
  });

  // Déconnexion
  socket.on('disconnect', () => {
    console.log('❌ Utilisateur déconnecté:', socket.id);
    
    if (socket.userId) {
      users.delete(socket.userId);
      
      if (donneurs.has(socket.userId)) {
        const donneur = donneurs.get(socket.userId);
        donneur.connecte = false;
        donneurs.set(socket.userId, donneur);
      }
    }
  });
});

// Fonction Haversine
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // Rayon de la Terre en km
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.asin(Math.sqrt(a));
  return R * c;
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

// API REST pour vérifier le serveur
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    users: users.size,
    donneurs: donneurs.size
  });
});

app.get('/donneurs', (req, res) => {
  const donneursList = Array.from(donneurs.entries()).map(([id, data]) => ({
    id,
    groupe: data.groupe,
    latitude: data.latitude,
    longitude: data.longitude,
    connecte: data.connecte
  }));
  res.json(donneursList);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur BloodLink démarré sur le port ${PORT}`);
});
