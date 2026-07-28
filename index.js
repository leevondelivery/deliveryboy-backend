 require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');
const fs = require('fs');
const path = require('path');

const { getApps } = require('firebase-admin/app');

// Initialize Firebase Admin SDK
function initFirebaseAdmin() {
  try {
    if ((typeof getApps === 'function' && getApps().length > 0) || (admin.apps && admin.apps.length > 0)) {
      return true;
    }
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      const serviceAccount = JSON.parse(rawJson);
      admin.initializeApp({
        credential: admin.cert(serviceAccount)
      });
      console.log('Firebase Admin SDK initialized successfully via FIREBASE_SERVICE_ACCOUNT env var.');
      return true;
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      const privateKey = process.env.FIREBASE_PRIVATE_KEY
        .replace(/^"|"$/g, '')
        .replace(/\\n/g, '\n');
      admin.initializeApp({
        credential: admin.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: privateKey,
        })
      });
      console.log('Firebase Admin SDK initialized successfully via individual env vars.');
      return true;
    } else if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = require(serviceAccountPath);
      admin.initializeApp({
        credential: admin.cert(serviceAccount)
      });
      console.log('Firebase Admin SDK initialized successfully via serviceAccountKey.json.');
      return true;
    } else {
      console.warn('Firebase credentials not found (neither in environment variables nor serviceAccountKey.json). Push notifications will not work.');
      return false;
    }
  } catch (error) {
    if (error.code === 'app/duplicate-app' || error.code === 'app/invalid-app-options' || (error.message && error.message.includes('already exists'))) {
      return true;
    }
    console.error('Error initializing Firebase Admin SDK:', error);
    return false;
  }
}

initFirebaseAdmin();


const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
let mongoURI = process.env.MONGODB_URI || process.env.MongoURL;

if (mongoURI) {
  // Clean up whitespace and any surrounding quotes that might have been copied/pasted accidentally
  mongoURI = mongoURI.trim().replace(/^["']|["']$/g, '');

  // Strip accidental key prefixes from the value
  if (mongoURI.startsWith('MongoURL=')) {
    mongoURI = mongoURI.substring('MongoURL='.length);
  } else if (mongoURI.toUpperCase().startsWith('MONGODB_URI=')) {
    mongoURI = mongoURI.substring('MONGODB_URI='.length);
  }

  // Clean up whitespace and quotes again
  mongoURI = mongoURI.trim().replace(/^["']|["']$/g, '');
}

if (!mongoURI) {
  console.error('CRITICAL ERROR: MongoDB connection URI is not defined.');
  console.error('Please configure MONGODB_URI or MongoURL in your environment variables (e.g., in your Render dashboard or local .env file).');
  process.exit(1);
}

if (!mongoURI.startsWith('mongodb://') && !mongoURI.startsWith('mongodb+srv://')) {
  console.error('CRITICAL ERROR: Invalid MongoDB connection URI format.');
  console.error(`Expected it to start with "mongodb://" or "mongodb+srv://", but got: "${mongoURI.substring(0, 15)}..."`);
  console.error('Please check your environment variables in the Render dashboard and make sure it is configured correctly.');
  process.exit(1);
}

mongoose.connect(mongoURI)
  .then(() => {
    console.log('Successfully connected to MongoDB.');
    setupOrderListener();
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });



// Schema definition matching the "deliveryboyusers" collection exactly
const userSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String },
    firebaseUid: { type: String },
    aadharUrl: { type: String },
    aadharNumber: { type: String },
    rcUrl: { type: String },
    rcNumber: { type: String },
    licenseUrl: { type: String },
    licenseNumber: { type: String },
    accountNumber: { type: String },
    ifscCode: { type: String },
    isActive: { type: Boolean, default: false }, // Syncs active/inactive state
    pushToken: { type: String }, // For FCM push notificat
  },
  { 
    timestamps: true, // Hndles createdAt and updatedAt automatically
    collection: 'deliveryboyusers' // Forces Mongoose to use the exact collection name
  }
);

const User = mongoose.model('User', userSchema);

// Schema definition for pending delivery boys waiting for admin approval
const pendingUserSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String },
    firebaseUid: { type: String },
    aadharUrl: { type: String },
    aadharNumber: { type: String },
    rcUrl: { type: String },
    rcNumber: { type: String },
    licenseUrl: { type: String },
    licenseNumber: { type: String },
    accountNumber: { type: String },
    ifscCode: { type: String },
    isActive: { type: Boolean, default: false },
  },
  { 
    timestamps: true, 
    collection: 'Deliveryboynewadd' // Forces collection name
  }
);

const PendingUser = mongoose.model('PendingUser', pendingUserSchema);

// Helper to build a phone query matching both with and without the +91 prefix
const getPhoneQuery = (phone) => {
  if (!phone) return {};
  const cleanPhone = phone.trim();
  const phoneWithPrefix = cleanPhone.startsWith('+91') ? cleanPhone : `+91${cleanPhone}`;
  const phoneWithoutPrefix = cleanPhone.startsWith('+91') ? cleanPhone.slice(3) : cleanPhone;
  return {
    $or: [
      { phone: cleanPhone },
      { phone: phoneWithPrefix },
      { phone: phoneWithoutPrefix }
    ]
  };
};

// Signup Endpoint - saves to Deliveryboynewadd for admin review
app.post('/api/deliveryboy/signup', async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phone,
      firebaseUid,
      aadharUrl,
      aadharNumber,
      rcUrl,
      rcNumber,
      licenseUrl,
      licenseNumber,
      accountNumber,
      ifscCode
    } = req.body;

    // Check if phone number is already registered in deliveryboyusers
    const existingRegisteredUser = await User.findOne(getPhoneQuery(phone));
    if (existingRegisteredUser) {
      return res.status(400).json({ message: 'Phone number is already registered.' });
    }

    // Check if phone number is already pending in Deliveryboynewadd
    const existingPendingUser = await PendingUser.findOne(getPhoneQuery(phone));
    if (existingPendingUser) {
      return res.status(400).json({ message: 'A registration request with this phone number is already pending admin approval.' });
    }

    // Check email if provided
    if (email) {
      const existingEmail = await User.findOne({ email });
      if (existingEmail) {
        return res.status(400).json({ message: 'Email address is already registered.' });
      }
      const existingPendingEmail = await PendingUser.findOne({ email });
      if (existingPendingEmail) {
        return res.status(400).json({ message: 'A registration request with this email is already pending admin approval.' });
      }
    }

    // Create a new pending user document
    const pendingUser = new PendingUser({
      name,
      email,
      password,
      phone,
      firebaseUid,
      aadharUrl,
      aadharNumber,
      rcUrl,
      rcNumber,
      licenseUrl,
      licenseNumber,
      accountNumber,
      ifscCode,
      isActive: false // Keep it false initially
    });

    await pendingUser.save();

    return res.status(201).json({
      message: 'Registration request submitted successfully. Please wait for admin approval.'
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Check if phone number exists in deliveryboyusers collection
app.post('/api/deliveryboy/check-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    const user = await User.findOne(getPhoneQuery(phone));
    if (!user) {
      return res.status(404).json({ success: false, message: 'Phone number not found.' });
    }

    return res.status(200).json({ success: true, message: 'Phone number verified.' });
  } catch (error) {
    console.error('Check phone error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Update/Reset password for a delivery boy
app.post('/api/deliveryboy/reset-password', async (req, res) => {
  try {
    const { phone, newPassword } = req.body;
    if (!phone || !newPassword) {
      return res.status(400).json({ success: false, message: 'Phone number and new password are required' });
    }

    const user = await User.findOneAndUpdate(
      getPhoneQuery(phone),
      { password: newPassword },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    return res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ message: 'Phone and password are required' });
    }

    // Find the user by phone number
    const user = await User.findOne(getPhoneQuery(phone));
    if (!user) {
      return res.status(404).json({ message: 'no account found', errorType: 'NO_ACCOUNT' });
    }

    // Compare the plaintext passwords
    if (user.password !== password) {
      return res.status(401).json({ message: 'incorrect id and password', errorType: 'INCORRECT_PASSWORD' });
    }

    // Success response returning requested fields
    return res.status(200).json({
      message: 'Login successful',
      user: {
        _id: user._id,
        name: user.name,
        phone: user.phone,
        isActive: user.isActive,
        updatedAt: user.updatedAt,
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Fetch User Profile Endpoint
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.status(200).json({
      _id: user._id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      isActive: user.isActive,
      aadharUrl: user.aadharUrl,
      aadharNumber: user.aadharNumber,
      rcUrl: user.rcUrl,
      rcNumber: user.rcNumber,
      licenseUrl: user.licenseUrl,
      licenseNumber: user.licenseNumber,
      accountNumber: user.accountNumber,
      ifscCode: user.ifscCode,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  } catch (error) {
    console.error('Fetch user status error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Update User Active Status Endpoint
app.put('/api/users/:id/status', async (req, res) => {
  try {
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive field is required and must be a boolean' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true } // Returns the updated document
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.status(200).json({
      message: 'Active status updated successfully',
      isActive: user.isActive,
    });
  } catch (error) {
    console.error('Update user status error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Update User Push Token Endpoint
app.put('/api/users/:id/push-token', async (req, res) => {
  try {
    const { pushToken } = req.body;

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { pushToken },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.status(200).json({
      message: 'Push token updated successfully',
      pushToken: user.pushToken,
    });
  } catch (error) {
    console.error('Update user push token error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// FCM Diagnostic and Test Endpoint
app.get('/api/diagnose-fcm', async (req, res) => {
  try {
    const activeUsers = await User.find({
      isActive: true,
      pushToken: { $exists: true, $ne: '' }
    });

    const initializationStatus = admin.getApps().length > 0 ? 'Initialized' : 'Not Initialized';
    
    let sendResult = null;
    if (activeUsers.length > 0 && admin.getApps().length > 0) {
      const tokens = [...new Set(activeUsers.map(user => user.pushToken))];
      const testMessage = {
        notification: {
          title: 'Test Notification',
          body: 'This is a test notification from the backend diagnostic tool.',
        },
        android: {
          priority: 'high',
          notification: {
            sound: 'ordernotification',
            channelId: 'order_notifications',
            icon: 'ic_notification',
            largeIcon: 'ic_launcher'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'ordernotification.wav',
            },
          },
        },
        tokens: tokens,
      };
      try {
        sendResult = await getMessaging().sendEachForMulticast(testMessage);
      } catch (err) {
        sendResult = { error: err.message };
      }
    }

    return res.status(200).json({
      firebaseAdminStatus: initializationStatus,
      firebaseConfiguredEnv: {
        projectId: !!process.env.FIREBASE_PROJECT_ID,
        clientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
        privateKeyExists: !!process.env.FIREBASE_PRIVATE_KEY
      },
      activeUsersCount: activeUsers.length,
      activeUsers: activeUsers.map(u => ({ name: u.name, phone: u.phone, hasToken: !!u.pushToken })),
      sendResult: sendResult
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Fetch Delivery Boy Earnings and Orders Endpoint
app.get('/api/deliveryboy/:id/earnings', async (req, res) => {
  try {
    const deliveryBoyId = req.params.id;
    const db = mongoose.connection.db;
    const orders = await db.collection('finalcompletedorders')
      .find({ deliveryBoyId: deliveryBoyId })
      .toArray();

    const now = new Date();
    
    // Define start boundaries in server local time
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    let todayOrdersCount = 0;
    let todayEarningsSum = 0;
    let monthlyOrdersCount = 0;
    let monthlyEarningsSum = 0;

    orders.forEach(order => {
      const completedDate = order.completedAt ? new Date(order.completedAt) : null;
      if (!completedDate) return;

      const charge = Number(order.deliveryboyCharges || order.deliveryCharge || 0);

      // Check if it is today
      if (completedDate >= startOfToday) {
        todayOrdersCount++;
        todayEarningsSum += charge;
      }

      // Check if it is this month
      if (completedDate >= startOfThisMonth) {
        monthlyOrdersCount++;
        monthlyEarningsSum += charge;
      }
    });

    return res.status(200).json({
      todayOrders: todayOrdersCount,
      todayEarnings: todayEarningsSum,
      totalOrders: monthlyOrdersCount, // Centered under Monthly Record
      monthlyEarnings: monthlyEarningsSum,
    });
  } catch (error) {
    console.error('Fetch earnings error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Fetch Delivery Boy Completed Orders list
app.get('/api/deliveryboy/:id/orders', async (req, res) => {
  try {
    const deliveryBoyId = req.params.id;
    const db = mongoose.connection.db;
    const orders = await db.collection('finalcompletedorders')
      .find({ deliveryBoyId: deliveryBoyId })
      .sort({ completedAt: -1 })
      .toArray();

    return res.status(200).json(orders);
  } catch (error) {
    console.error('Fetch completed orders error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Fetch all active accepted orders
app.get('/api/acceptedorders', async (req, res) => {
  try {
    const { deliveryBoyId } = req.query;
    const db = mongoose.connection.db;

    let query = {};
    if (deliveryBoyId) {
      query = {
        $or: [
          { deliveryBoyId: { $exists: false } },
          { deliveryBoyId: null },
          { deliveryBoyId: "" },
          { deliveryBoyId: deliveryBoyId }
        ]
      };
    }

    const orders = await db.collection('acceptedorders')
      .find(query)
      .sort({ orderDate: -1 })
      .toArray();

    return res.status(200).json(orders);
  } catch (error) {
    console.error('Fetch accepted orders error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Reject an active accepted order
app.put('/api/acceptedorders/:id/reject', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { deliveryBoyId } = req.body;

    if (!deliveryBoyId) {
      return res.status(400).json({ message: 'deliveryBoyId is required' });
    }

    const db = mongoose.connection.db;
    
    // Check if orderId is a valid ObjectId, otherwise query as string
    let query = {};
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query = { _id: new mongoose.Types.ObjectId(orderId) };
    } else {
      query = { _id: orderId };
    }

    const result = await db.collection('acceptedorders').updateOne(
      query,
      { $addToSet: { rejectedBy: deliveryBoyId } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }

    return res.status(200).json({ message: 'Order rejected successfully' });
  } catch (error) {
    console.error('Reject order error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Accept an active order
app.post('/api/acceptedorders/:id/accept', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { deliveryBoyId, deliveryBoyName, deliveryBoyPhone } = req.body;

    if (!deliveryBoyId || !deliveryBoyName || !deliveryBoyPhone) {
      return res.status(400).json({ message: 'deliveryBoyId, deliveryBoyName, and deliveryBoyPhone are required' });
    }

    const db = mongoose.connection.db;

    let query = {};
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query = { _id: new mongoose.Types.ObjectId(orderId) };
    } else {
      query = { _id: orderId };
    }

    // Find the order details from acceptedorders
    const order = await db.collection('acceptedorders').findOne(query);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check if the order has already been accepted by checking acceptedbydeliveries collection
    const existing = await db.collection('acceptedbydeliveries').findOne({ orderId: order.orderId });
    if (existing) {
      return res.status(409).json({ message: 'Order has already been accepted by another delivery partner' });
    }

    // Prepare document for acceptedbydeliveries collection preserving ALL order fields
    const acceptedOrderDoc = {
      ...order,
      originalOrderId: order._id.toString(),
      deliveryBoyId,
      deliveryBoyName,
      deliveryBoyPhone,
      deliveryFee: order.deliveryFee ?? order.deliveryCharge ?? 0,
      deliveryCharge: order.deliveryCharge ?? order.deliveryFee ?? 0,
      deliveryDistance: order.deliveryDistance ?? order.distance ?? (order.location && typeof order.location === 'object' ? order.location.distanceText : null),
      userCoordinates: order.userCoordinates || order.location,
      status: 'Accepted by Delivery',
      acceptedAt: new Date(),
      updatedAt: new Date()
    };
    delete acceptedOrderDoc._id; // Remove original _id so MongoDB creates a new unique ObjectId for acceptedbydeliveries

    // Insert into acceptedbydeliveries
    await db.collection('acceptedbydeliveries').insertOne(acceptedOrderDoc);

    // Update the order in acceptedorders with the delivery boy details
    await db.collection('acceptedorders').updateOne(
      query,
      {
        $set: {
          deliveryBoyId,
          deliveryBoyName,
          deliveryBoyPhone,
          updatedAt: new Date()
        }
      }
    );

    // Update status in orderstatuses collection
    await db.collection('orderstatuses').updateOne(
      { orderId: order.orderId },
      {
        $set: {
          status: 'will be delivered soon',
          deliveryBoyId,
          deliveryBoyName,
          deliveryBoyPhone,
          updatedAt: new Date()
        }
      }
    );

    return res.status(200).json({ message: 'Order accepted successfully', orderId: order.orderId });
  } catch (error) {
    console.error('Accept order error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Fetch active order for a delivery boy
app.get('/api/deliveryboy/:id/activeorder', async (req, res) => {
  try {
    const deliveryBoyId = req.params.id;
    const db = mongoose.connection.db;
    const activeOrder = await db.collection('acceptedbydeliveries').findOne({ deliveryBoyId });
    if (!activeOrder) {
      return res.status(404).json({ message: 'No active order found' });
    }
    return res.status(200).json(activeOrder);
  } catch (error) {
    console.error('Fetch active order error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Pickup an active order (change status to 'out for delivery')
app.post('/api/acceptedbydeliveries/:id/pickup', async (req, res) => {
  try {
    const orderId = req.params.id; // can be ORD-00705 or database _id
    const db = mongoose.connection.db;

    let query = {};
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query = { _id: new mongoose.Types.ObjectId(orderId) };
    } else {
      query = { orderId: orderId };
    }

    const order = await db.collection('acceptedbydeliveries').findOne(query);
    if (!order) {
      return res.status(404).json({ message: 'Active order not found' });
    }

    // Update status in acceptedbydeliveries to 'out for delivery'
    await db.collection('acceptedbydeliveries').updateOne(
      query,
      {
        $set: {
          status: 'out for delivery',
          updatedAt: new Date()
        }
      }
    );

    // Update status in orderstatuses to 'out for delivery'
    await db.collection('orderstatuses').updateOne(
      { orderId: order.orderId },
      {
        $set: {
          status: 'out for delivery',
          updatedAt: new Date()
        }
      }
    );

    // Delete the order from acceptedorders collection when picking it up
    await db.collection('acceptedorders').deleteOne({ orderId: order.orderId });

    return res.status(200).json({ message: 'Order status updated to out for delivery', orderId: order.orderId });
  } catch (error) {
    console.error('Pickup order error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Complete active order delivery by checking OTP
app.post('/api/acceptedbydeliveries/:id/complete', async (req, res) => {
  try {
    const orderId = req.params.id; // ORD-00705 or document _id
    const { otp } = req.body;

    if (!otp) {
      return res.status(400).json({ message: 'OTP is required' });
    }

    const db = mongoose.connection.db;

    let query = {};
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query = { _id: new mongoose.Types.ObjectId(orderId) };
    } else {
      query = { orderId: orderId };
    }

    const order = await db.collection('acceptedbydeliveries').findOne(query);
    if (!order) {
      return res.status(404).json({ message: 'Active order not found' });
    }

    // Verify OTP (last 5 digits/chars of razorpayOrderId, case-insensitive)
    const razorpayId = order.razorpayOrderId || '';
    const expectedOtp = razorpayId.slice(-5);

    if (expectedOtp.toLowerCase() !== otp.trim().toLowerCase()) {
      return res.status(400).json({ message: 'Invalid OTP. Please check and try again.' });
    }

    // Move to finalcompletedorders with completedAt date
    const completedDoc = {
      ...order,
      completedAt: new Date(),
      status: 'delivered',
      updatedAt: new Date()
    };
    delete completedDoc._id; // Remove acceptedbydeliveries _id to avoid collision

    await db.collection('finalcompletedorders').insertOne(completedDoc);

    // Delete from acceptedbydeliveries
    await db.collection('acceptedbydeliveries').deleteOne(query);

    // Delete from orderstatuses collection
    await db.collection('orderstatuses').deleteOne({ orderId: order.orderId });

    // Update pending payments for the delivery boy
    try {
      const deliveryBoyId = order.deliveryBoyId;
      const deliveryBoyName = order.deliveryBoyName;
      const deliveryBoyPhone = order.deliveryBoyPhone;
      const deliveryCharge = Number(order.deliveryCharge || 0);

      if (deliveryBoyId) {
        let accountNumber = '';
        let ifscCode = '';
        try {
          const boyProfile = await User.findById(deliveryBoyId).lean();
          if (boyProfile) {
            accountNumber = boyProfile.accountNumber || '';
            ifscCode = boyProfile.ifscCode || '';
          }
        } catch (profileErr) {
          console.error('Error fetching delivery boy bank details on order completion:', profileErr);
        }

        await db.collection('pendingpaymentsofdeliveryboy').updateOne(
          { 
            $or: [
              { userid: deliveryBoyId },
              { deliveryBoyId: deliveryBoyId }
            ]
          },
          {
            $set: {
              userid: deliveryBoyId,
              deliveryBoyId: deliveryBoyId,
              name: deliveryBoyName,
              deliveryBoyName: deliveryBoyName,
              phonenumber: deliveryBoyPhone,
              deliveryBoyPhone: deliveryBoyPhone,
              accountNumber: accountNumber,
              ifscCode: ifscCode
            },
            $inc: {
              deliverycharges: deliveryCharge,
              deliveryCharge: deliveryCharge
            }
          },
          { upsert: true }
        );
      }
    } catch (paymentErr) {
      console.error('Error updating pendingpaymentsofdeliveryboy:', paymentErr);
    }

    return res.status(200).json({ message: 'Order completed successfully', orderId: order.orderId });
  } catch (error) {
    console.error('Complete order error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Fetch order reviews for a delivery boy
app.get('/api/deliveryboy/:id/reviews', async (req, res) => {
  try {
    const deliveryBoyId = req.params.id;
    const db = mongoose.connection.db;
    const reviews = await db.collection('orderreviews')
      .find({ deliveryBoyId: deliveryBoyId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json(reviews);
  } catch (error) {
    console.error('Fetch reviews error:', error);
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Function to send FCM notification to all active delivery partners
async function sendFCMToActiveDeliveryBoys(order) {
  try {
    if (!initFirebaseAdmin()) {
      console.warn('Firebase Admin SDK is not initialized. Skipping push notification.');
      return;
    }
    // Find all active delivery boy users who have registered a push token
    const activeUsers = await User.find({
      isActive: true,
      pushToken: { $exists: true, $ne: '' }
    });

    if (activeUsers.length === 0) {
      console.log('No active delivery partners with registered push tokens found.');
      return;
    }

    const tokens = [...new Set(activeUsers.map(user => user.pushToken))];
    console.log(`Sending new order notification to ${tokens.length} active delivery partners.`);

    const message = {
      notification: {
        title: 'New Order Available!',
        body: `New order from ${order.restaurantName || 'Restaurant'} is available. Delivery Fee: ₹${order.deliveryFee ?? order.deliveryCharge ?? 0}`,
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'ordernotification',
          channelId: 'order_notifications',
          icon: 'ic_notification',
          largeIcon: 'ic_launcher'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'ordernotification.wav',
          },
        },
      },
      tokens: tokens,
    };

    // Send using FCM admin SDK (sendEachForMulticast)
    const response = await getMessaging().sendEachForMulticast(message);
    console.log(`Successfully sent ${response.successCount} messages; ${response.failureCount} failed.`);
    
    // Optionally clean up invalid tokens if they failed
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const error = resp.error;
          if (error && (error.code === 'messaging/registration-token-not-registered' || error.code === 'messaging/invalid-registration-token')) {
            const badToken = tokens[idx];
            console.log(`Cleaning up invalid token: ${badToken}`);
            User.updateOne({ pushToken: badToken }, { $unset: { pushToken: 1 } })
              .catch(err => console.error('Failed to clean up invalid token:', err));
          }
        }
      });
    }
  } catch (error) {
    console.error('Error sending FCM notifications:', error);
  }
}

let isPollingActive = false;

// Set up MongoDB listener for acceptedorders collection
function setupOrderListener() {
  const db = mongoose.connection.db;
  const collection = db.collection('acceptedorders');

  console.log('Setting up MongoDB Order Change Stream listener...');

  let changeStream;
  try {
    changeStream = collection.watch([
      { $match: { operationType: 'insert' } }
    ]);

    changeStream.on('change', async (change) => {
      console.log('New order detected via Change Stream:', change.fullDocument.orderId);
      await sendFCMToActiveDeliveryBoys(change.fullDocument);
    });

    changeStream.on('error', (err) => {
      console.error('Change stream error:', err.message || err);
      if (changeStream) {
        changeStream.close().catch(() => {});
      }
      if (!isPollingActive) {
        isPollingActive = true;
        setupPollingFallback();
      }
    });
  } catch (error) {
    console.error('Failed to start change stream:', error.message || error);
    if (!isPollingActive) {
      isPollingActive = true;
      setupPollingFallback();
    }
  }
}

// Fallback polling for MongoDB instances without replica set configured
function setupPollingFallback() {
  console.log('Setting up database polling fallback (every 10 seconds)...');
  const db = mongoose.connection.db;
  const collection = db.collection('acceptedorders');

  let knownOrderIds = new Set();
  let isFirstLoad = true;

  const poll = async () => {
    try {
      const orders = await collection.find({}).toArray();
      const currentOrderIds = new Set(orders.map(o => o.orderId));

      if (isFirstLoad) {
        knownOrderIds = currentOrderIds;
        isFirstLoad = false;
        console.log(`Polling initialized with ${knownOrderIds.size} existing orders.`);
        return;
      }

      // Check for new orders
      for (const order of orders) {
        if (!knownOrderIds.has(order.orderId)) {
          console.log('New order detected via polling:', order.orderId);
          await sendFCMToActiveDeliveryBoys(order);
        }
      }

      knownOrderIds = currentOrderIds;
    } catch (error) {
      console.error('Polling error:', error);
    }
  };

  // Run poll every 10 seconds
  setInterval(poll, 10000);
}

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server is running on port ${PORT}`);
});



