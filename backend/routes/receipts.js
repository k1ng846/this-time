const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDatabase } = require('../database/init');
const { authenticateToken, requireCustomerOrAdmin } = require('../middleware/auth');

const router = express.Router();

// Generate receipt for booking
router.post('/generate', [
  authenticateToken,
  requireCustomerOrAdmin,
  body('bookingId').isInt(),
  body('paymentMethod').optional().trim().escape(),
  body('paymentStatus').optional().isIn(['pending', 'paid', 'failed', 'refunded'])
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { bookingId, paymentMethod = 'Cash/Card', paymentStatus = 'pending' } = req.body;
  const db = getDatabase();

  // Get booking details
  db.get(
    `SELECT b.*, u.first_name, u.last_name, u.email, u.phone_number
     FROM bookings b
     JOIN users u ON b.user_id = u.id
     WHERE b.id = ?`,
    [bookingId],
    (err, booking) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      // Check if user is admin or booking owner
      if (req.user.userType !== 'admin' && booking.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Get booking items
      db.all(
        `SELECT bi.*, mi.item_name, mi.description, mi.category
         FROM booking_items bi
         JOIN menu_items mi ON bi.item_id = mi.id
         WHERE bi.booking_id = ?`,
        [bookingId],
        (err, items) => {
          if (err) {
            return res.status(500).json({ error: 'Database error' });
          }

          // Calculate totals
          const subtotal = booking.total_amount || 0;
          const taxRate = 0.12; // 12% VAT
          const taxAmount = subtotal * taxRate;
          const totalAmount = subtotal + taxAmount;

          // Generate receipt ID and number
          const receiptId = `RCP-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
          const receiptNumber = `R${Date.now().toString().slice(-6)}`;

          // Create receipt
          db.run(
            `INSERT INTO receipts (receipt_id, booking_id, receipt_number, subtotal, tax_rate, tax_amount, total_amount, payment_method, payment_status, issued_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [receiptId, bookingId, receiptNumber, subtotal, totalAmount, paymentMethod, paymentStatus, new Date().toISOString().split('T')[0]],
            function(err) {
              if (err) {
                return res.status(500).json({ error: 'Failed to create receipt' });
              }

              const receipt = {
                id: this.lastID,
                receiptId,
                receiptNumber,
                bookingId: booking.booking_id,
                customerName: `${booking.first_name} ${booking.last_name}`,
                customerEmail: booking.email,
                customerPhone: booking.phone_number,
                eventType: booking.event_type,
                eventDate: booking.event_date,
                eventVenue: booking.event_venue,
                numGuests: booking.num_guests,
                items: items,
                subtotal,
                totalAmount,
                paymentMethod,
                paymentStatus,
                issuedDate: new Date().toISOString().split('T')[0],
                createdAt: new Date().toISOString()
              };

              res.status(201).json({
                message: 'Receipt generated successfully',
                receipt
              });
            }
          );
        }
      );
    }
  );
});

// Get all receipts (admin) or user's receipts
router.get('/', authenticateToken, requireCustomerOrAdmin, (req, res) => {
  const db = getDatabase();
  const isAdmin = req.user.userType === 'admin';
  
  let query = `
    SELECT r.*, b.booking_id, b.event_type, b.event_date, b.event_venue, b.num_guests,
           u.first_name, u.last_name, u.email
    FROM receipts r
    JOIN bookings b ON r.booking_id = b.id
    JOIN users u ON b.user_id = u.id
  `;
  
  const params = [];
  if (!isAdmin) {
    query += ' WHERE b.user_id = ?';
    params.push(req.user.id);
  }
  
  query += ' ORDER BY r.created_at DESC';

  db.all(query, params, (err, receipts) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ receipts });
  });
});

// Get single receipt
router.get('/:id', authenticateToken, requireCustomerOrAdmin, (req, res) => {
  const db = getDatabase();
  const receiptId = req.params.id;
  const isAdmin = req.user.userType === 'admin';
  
  let query = `
    SELECT r.*, b.booking_id, b.event_type, b.event_date, b.event_venue, b.num_guests,
           u.first_name, u.last_name, u.email, u.phone_number
    FROM receipts r
    JOIN bookings b ON r.booking_id = b.id
    JOIN users u ON b.user_id = u.id
    WHERE r.id = ?
  `;
  
  const params = [receiptId];
  if (!isAdmin) {
    query += ' AND b.user_id = ?';
    params.push(req.user.id);
  }

  db.get(query, params, (err, receipt) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!receipt) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    // Get receipt items
    db.all(
      `SELECT bi.*, mi.item_name, mi.description, mi.category
       FROM booking_items bi
       JOIN menu_items mi ON bi.item_id = mi.id
       WHERE bi.booking_id = ?`,
      [receipt.booking_id],
      (err, items) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }

        res.json({ 
          receipt: {
            ...receipt,
            items
          }
        });
      }
    );
  });
});

// Update payment status (admin only)
router.patch('/:id/payment-status', [
  authenticateToken,
  requireCustomerOrAdmin,
  body('paymentStatus').isIn(['pending', 'paid', 'failed', 'refunded'])
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { paymentStatus } = req.body;
  const receiptId = req.params.id;
  const db = getDatabase();

  // Check if user is admin or receipt owner
  db.get(
    `SELECT b.user_id FROM receipts r
     JOIN bookings b ON r.booking_id = b.id
     WHERE r.id = ?`,
    [receiptId],
    (err, result) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (!result) {
        return res.status(404).json({ error: 'Receipt not found' });
      }

      if (req.user.userType !== 'admin' && result.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      db.run(
        'UPDATE receipts SET payment_status = ? WHERE id = ?',
        [paymentStatus, receiptId],
        (err) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to update payment status' });
          }

          res.json({ message: 'Payment status updated successfully' });
        }
      );
    }
  );
});

// Get receipt by booking ID
router.get('/booking/:bookingId', authenticateToken, requireCustomerOrAdmin, (req, res) => {
  const db = getDatabase();
  const bookingId = req.params.bookingId;
  const isAdmin = req.user.userType === 'admin';
  
  let query = `
    SELECT r.*, b.booking_id, b.event_type, b.event_date, b.event_venue, b.num_guests,
           u.first_name, u.last_name, u.email, u.phone_number
    FROM receipts r
    JOIN bookings b ON r.booking_id = b.id
    JOIN users u ON b.user_id = u.id
    WHERE b.id = ?
  `;
  
  const params = [bookingId];
  if (!isAdmin) {
    query += ' AND b.user_id = ?';
    params.push(req.user.id);
  }

  db.get(query, params, (err, receipt) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!receipt) {
      return res.status(404).json({ error: 'Receipt not found for this booking' });
    }

    res.json({ receipt });
  });
});

module.exports = router;