const express = require('express');
const cors    = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// ============================================================
//   SUPABASE CLIENT
// ============================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ============================================================
//   EXPRESS APP
// ============================================================
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============================================================
//   ROUTE: Health check
// ============================================================
app.get('/', (req, res) => {
  res.json({ 
    status  : 'GPS Tracker Server is running',
    version : '1.0.0'
  });
});

// ============================================================
//   ROUTE: Receive GPS location from LilyGO
// ============================================================
app.post('/api/location', async (req, res) => {
  try {
    const { device_id, latitude, longitude, speed, altitude, satellites } = req.body;

    // Validate required fields
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    if (latitude < -90 || latitude > 90) {
      return res.status(400).json({ error: 'Invalid latitude value' });
    }

    if (longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Invalid longitude value' });
    }

    // Save to Supabase
    const { data, error } = await supabase
      .from('locations')
      .insert([{
        device_id  : device_id  || 'tracker_01',
        latitude,
        longitude,
        speed      : speed      || 0,
        altitude   : altitude   || 0,
        satellites : satellites || 0
        source     : 'gps'
      }]);

    if (error) {
      console.error('[DB] Supabase error:', error.message);
      return res.status(500).json({ error: 'Database error', details: error.message });
    }

    console.log(`[GPS] Saved: Lat ${latitude}, Lng ${longitude}`);
    return res.status(201).json({ success: true, message: 'Location saved' });

  } catch (err) {
    console.error('[SERVER] Error:', err.message);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// ============================================================
//   ROUTE: Get latest location
// ============================================================
app.get('/api/location/latest', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(1);

    if (error) return res.status(500).json({ error: error.message });
    if (data.length === 0) return res.status(404).json({ error: 'No locations found' });

    return res.status(200).json(data[0]);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   ROUTE: Get location history
// ============================================================
app.get('/api/location/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;

    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   ROUTE: Receive WiFi trilateration data
// ============================================================
app.post('/api/wifi-location', async (req, res) => {
  try {
    const { device_id, networks } = req.body;

    if (!networks || networks.length === 0) {
      return res.status(400).json({ error: 'No WiFi networks provided' });
    }

    // Fetch known anchor points from Supabase
    const { data: anchors, error: anchorError } = await supabase
      .from('wifi_anchors')
      .select('*')
      .eq('active', true);

    if (anchorError) return res.status(500).json({ error: anchorError.message });

    // Match scanned networks with known anchors
    const matched = [];
    for (const network of networks) {
      const anchor = anchors.find(a => a.ssid === network.ssid);
      if (anchor) {
        // Convert RSSI to distance using path loss model
        const distance = Math.pow(10, (anchor.tx_power - network.rssi) / (10 * 2.0));
        matched.push({
          latitude  : anchor.latitude,
          longitude : anchor.longitude,
          distance
        });
      }
    }

    if (matched.length === 0) {
      return res.status(404).json({ error: 'No known anchors found' });
    }

    // Calculate weighted centroid position
    let totalWeight = 0;
    let weightedLat = 0;
    let weightedLng = 0;

    for (const point of matched) {
      const weight = 1 / (point.distance * point.distance);
      weightedLat += point.latitude  * weight;
      weightedLng += point.longitude * weight;
      totalWeight += weight;
    }

    const estimatedLat = weightedLat / totalWeight;
    const estimatedLng = weightedLng / totalWeight;

    // Save estimated location to Supabase
    const { error: insertError } = await supabase
      .from('locations')
      .insert([{
        device_id  : device_id || 'tracker_01',
        latitude   : estimatedLat,
        longitude  : estimatedLng,
        speed      : 0,
        altitude   : 0,
        satellites : 0
        source     : 'wifi'
      }]);

    if (insertError) return res.status(500).json({ error: insertError.message });

    console.log(`[WiFi] Estimated position: ${estimatedLat}, ${estimatedLng} from ${matched.length} anchors`);

    return res.status(201).json({
      success    : true,
      latitude   : estimatedLat,
      longitude  : estimatedLng,
      anchors_used: matched.length
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   ROUTE: Setup WiFi anchors
// ============================================================
app.post('/api/wifi-anchors/setup', async (req, res) => {
  try {
    // Delete existing anchors
    await supabase.from('wifi_anchors').delete().neq('id', 0);

    // Insert our routers
    const { data, error } = await supabase
      .from('wifi_anchors')
      .insert([
        {
          ssid        : 'MTN_4G_E09BD1',
          latitude    : 5.6893632,
          longitude   : -0.2097933,
          tx_power    : -59,
          description : 'MTN Router',
          active      : true
        },
        {
          ssid        : 'Tenda_030398',
          latitude    : 5.6894736,
          longitude   : -0.2098564,
          tx_power    : -59,
          description : 'Tenda Router',
          active      : true
        }
      ]);

    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({ 
      success : true, 
      message : '2 WiFi anchors configured successfully' 
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   ROUTE: Get WiFi anchors
// ============================================================
app.get('/api/wifi-anchors', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('wifi_anchors')
      .select('*')
      .eq('active', true);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
//   START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`[SERVER] GPS Tracker Server running on port ${PORT}`);
  console.log(`[SERVER] Health check: http://localhost:${PORT}`);
  console.log(`[SERVER] POST location: http://localhost:${PORT}/api/location`);
  console.log(`[SERVER] GET latest:    http://localhost:${PORT}/api/location/latest`);
  console.log(`[SERVER] GET history:   http://localhost:${PORT}/api/location/history`);
});