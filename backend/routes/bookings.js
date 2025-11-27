const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDatabase } = require('../database/init');
const { authenticateToken, requireCustomerOrAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all bookings (admin) or user's bookings
router.get('/', authenticateToken, requireCustomerOrAdmin, (req, res) => {
  const db = getDatabase();
  const isAdmin = req.user.userType === 'admin';
  
  let query = `
    SELECT b.*, u.first_name, u.last_name, u.email, u.phone_number
    FROM bookings b
    JOIN users u ON b.user_id = u.id
  `;
  
  const params = [];
  if (!isAdmin) {
    query += ' WHERE b.user_id = ?';
    params.push(req.user.id);
  }
  
  query += ' ORDER BY b.created_at DESC';

  db.all(query, params, (err, bookings) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ bookings });
  });
});

// Get single booking
router.get('/:id', authenticateToken, requireCustomerOrAdmin, (req, res) => {
  const db = getDatabase();
  const bookingId = req.params.id;
  const isAdmin = req.user.userType === 'admin';
  
  let query = `
    SELECT b.*, u.first_name, u.last_name, u.email, u.phone_number
    FROM bookings b
    JOIN users u ON b.user_id = u.id
    WHERE b.id = ?
  `;
  
  const params = [bookingId];
  if (!isAdmin) {
    query += ' AND b.user_id = ?';
    params.push(req.user.id);
  }

  db.get(query, params, (err, booking) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
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

        res.json({ 
          booking: {
            ...booking,
            items
          }
        });
      }
    );
  });
});

// Create new booking
router.post('/', [
  authenticateToken,
  requireCustomerOrAdmin,
  body('eventType').notEmpty().trim().escape(),
  body('eventDate').isISO8601(),
  body('eventVenue').notEmpty().trim().escape(),
  body('numGuests').isInt({ min: 1 }),
  body('specialInstructions').optional().trim().escape(),
  body('menuItems').isArray({ min: 1 }),
  body('menuItems.*.itemId').isInt(),
  body('menuItems.*.quantity').isInt({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { eventType, eventDate, eventVenue, numGuests, specialInstructions, menuItems } = req.body;
    const db = getDatabase();

    // Generate booking ID
    const bookingId = `BK-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

    // Calculate total amount
    let totalAmount = 0;
    const validItems = [];

    for (const item of menuItems) {
      const menuItem = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM menu_items WHERE id = ? AND is_available = 1', [item.itemId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!menuItem) {
        return res.status(400).json({ error: `Menu item with ID ${item.itemId} not found or unavailable` });
      }

      const itemTotal = menuItem.price_per_serving * item.quantity;
      totalAmount += itemTotal;

      validItems.push({
        itemId: item.itemId,
        quantity: item.quantity,
        unitPrice: menuItem.price_per_serving,
        totalPrice: itemTotal
      });
    }

    // Create booking
    db.run(
      `INSERT INTO bookings (booking_id, user_id, event_type, event_date, event_venue, num_guests, special_instructions, total_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookingId, req.user.id, eventType, eventDate, eventVenue, numGuests, specialInstructions || '', totalAmount],
      function(err) {
        if (err) {
          return res.status(500).json({ error: 'Failed to create booking' });
        }

        const newBookingId = this.lastID;

        // Insert booking items
        const insertItem = db.prepare(`
          INSERT INTO booking_items (booking_id, item_id, quantity, unit_price, total_price)
          VALUES (?, ?, ?, ?, ?)
        `);

        validItems.forEach(item => {
          insertItem.run(newBookingId, item.itemId, item.quantity, item.unitPrice, item.totalPrice);
        });
        insertItem.finalize();

        res.status(201).json({
          message: 'Booking created successfully',
          booking: {
            id: newBookingId,
            bookingId,
            eventType,
            eventDate,
            eventVenue,
            numGuests,
            specialInstructions,
            totalAmount,
            items: validItems
          }
        });
      }
    );
  } catch (error) {
    console.error('Create booking error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update booking status (admin only)
router.patch('/:id/status', [
  authenticateToken,
  requireCustomerOrAdmin,
  body('status').isIn(['pending', 'confirmed', 'cancelled', 'completed'])
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { status } = req.body;
  const bookingId = req.params.id;
  const db = getDatabase();

  // Check if user is admin or booking owner
  db.get(
    'SELECT user_id FROM bookings WHERE id = ?',
    [bookingId],
    (err, booking) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      if (req.user.userType !== 'admin' && booking.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      db.run(
        'UPDATE bookings SET booking_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, bookingId],
        (err) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to update booking status' });
          }

          res.json({ message: 'Booking status updated successfully' });
        }
      );
    }
  );
});

// Delete booking
router.delete('/:id', authenticateToken, requireCustomerOrAdmin, (req, res) => {
  const bookingId = req.params.id;
  const db = getDatabase();

  // Check if user is admin or booking owner
  db.get(
    'SELECT user_id FROM bookings WHERE id = ?',
    [bookingId],
    (err, booking) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      if (req.user.userType !== 'admin' && booking.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Delete booking items first
      db.run('DELETE FROM booking_items WHERE booking_id = ?', [bookingId], (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to delete booking items' });
        }

        // Delete booking
        db.run('DELETE FROM bookings WHERE id = ?', [bookingId], (err) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to delete booking' });
          }

          res.json({ message: 'Booking deleted successfully' });
        });
      });
    }
  );
});

module.exports = router;