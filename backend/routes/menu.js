const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDatabase } = require('../database/init');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all menu items
router.get('/', (req, res) => {
  const db = getDatabase();
  const { category, available } = req.query;
  
  let query = 'SELECT * FROM menu_items WHERE 1=1';
  const params = [];
  
  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  
  if (available !== undefined) {
    query += ' AND is_available = ?';
    params.push(available === 'true' ? 1 : 0);
  }
  
  query += ' ORDER BY category, item_name';

  db.all(query, params, (err, items) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ items });
  });
});

// Get menu item by ID
router.get('/:id', (req, res) => {
  const db = getDatabase();
  const itemId = req.params.id;

  db.get('SELECT * FROM menu_items WHERE id = ?', [itemId], (err, item) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!item) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    res.json({ item });
  });
});

// Get menu categories
router.get('/categories/list', (req, res) => {
  const db = getDatabase();

  db.all('SELECT DISTINCT category FROM menu_items ORDER BY category', (err, categories) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ categories: categories.map(c => c.category) });
  });
});

// Create new menu item (admin only)
router.post('/', [
  authenticateToken,
  requireAdmin,
  body('itemName').notEmpty().trim().escape(),
  body('description').optional().trim().escape(),
  body('category').notEmpty().trim().escape(),
  body('pricePerServing').isFloat({ min: 0 }),
  body('imageUrl').optional().isURL(),
  body('isAvailable').optional().isBoolean()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { itemName, description, category, pricePerServing, imageUrl, isAvailable = true } = req.body;
  const db = getDatabase();

  db.run(
    `INSERT INTO menu_items (item_name, description, category, price_per_serving, image_url, is_available)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [itemName, description || '', category, pricePerServing, imageUrl || '', isAvailable ? 1 : 0],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to create menu item' });
      }

      res.status(201).json({
        message: 'Menu item created successfully',
        item: {
          id: this.lastID,
          itemName,
          description,
          category,
          pricePerServing,
          imageUrl,
          isAvailable
        }
      });
    }
  );
});

// Update menu item (admin only)
router.put('/:id', [
  authenticateToken,
  requireAdmin,
  body('itemName').optional().notEmpty().trim().escape(),
  body('description').optional().trim().escape(),
  body('category').optional().notEmpty().trim().escape(),
  body('pricePerServing').optional().isFloat({ min: 0 }),
  body('imageUrl').optional().isURL(),
  body('isAvailable').optional().isBoolean()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const itemId = req.params.id;
  const updates = req.body;
  const db = getDatabase();

  // Check if item exists
  db.get('SELECT * FROM menu_items WHERE id = ?', [itemId], (err, item) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!item) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    // Build update query dynamically
    const updateFields = [];
    const values = [];

    Object.keys(updates).forEach(key => {
      if (updates[key] !== undefined) {
        switch (key) {
          case 'itemName':
            updateFields.push('item_name = ?');
            values.push(updates[key]);
            break;
          case 'description':
            updateFields.push('description = ?');
            values.push(updates[key]);
            break;
          case 'category':
            updateFields.push('category = ?');
            values.push(updates[key]);
            break;
          case 'pricePerServing':
            updateFields.push('price_per_serving = ?');
            values.push(updates[key]);
            break;
          case 'imageUrl':
            updateFields.push('image_url = ?');
            values.push(updates[key]);
            break;
          case 'isAvailable':
            updateFields.push('is_available = ?');
            values.push(updates[key] ? 1 : 0);
            break;
        }
      }
    });

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(itemId);

    const query = `UPDATE menu_items SET ${updateFields.join(', ')} WHERE id = ?`;

    db.run(query, values, (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to update menu item' });
      }

      res.json({ message: 'Menu item updated successfully' });
    });
  });
});

// Delete menu item (admin only)
router.delete('/:id', authenticateToken, requireAdmin, (req, res) => {
  const itemId = req.params.id;
  const db = getDatabase();

  // Check if item is used in any bookings
  db.get(
    'SELECT COUNT(*) as count FROM booking_items WHERE item_id = ?',
    [itemId],
    (err, result) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (result.count > 0) {
        return res.status(400).json({ 
          error: 'Cannot delete menu item that is used in existing bookings' 
        });
      }

      db.run('DELETE FROM menu_items WHERE id = ?', [itemId], (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to delete menu item' });
        }

        res.json({ message: 'Menu item deleted successfully' });
      });
    }
  );
});

// Toggle availability (admin only)
router.patch('/:id/availability', authenticateToken, requireAdmin, (req, res) => {
  const itemId = req.params.id;
  const db = getDatabase();

  db.run(
    'UPDATE menu_items SET is_available = NOT is_available, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [itemId],
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to toggle availability' });
      }

      res.json({ message: 'Menu item availability updated successfully' });
    }
  );
});

module.exports = router;