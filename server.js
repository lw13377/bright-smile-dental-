require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection (supports all Vercel/Supabase env variable names)
// Use non-pooling URL for direct connection (better SSL compatibility)
const rawConnection =
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL;

// Strip sslmode param from URL so our ssl config takes full control
function cleanConnectionString(cs) {
    if (!cs) return cs;
    try {
        const url = new URL(cs);
        url.searchParams.delete('sslmode');
        url.searchParams.delete('pgbouncer');
        return url.toString();
    } catch (e) { return cs; }
}

const connectionString = cleanConnectionString(rawConnection);

const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

// Email configuration
const EMAIL_CONFIG = {
    enabled: true,
    clinicName: 'Bright Smile Dental',
    clinicPhone: '(555) 123-4567',
    clinicAddress: '123 Dental Avenue, Suite 100, New York, NY 10001'
};

let transporter;

async function initEmailTransporter() {
    try {
        const testAccount = await nodemailer.createTestAccount();
        transporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: { user: testAccount.user, pass: testAccount.pass }
        });
        console.log('Email configured:', testAccount.user);
    } catch (error) {
        console.log('Email setup failed:', error.message);
        EMAIL_CONFIG.enabled = false;
    }
}

async function sendConfirmationEmail(appointment) {
    if (!EMAIL_CONFIG.enabled || !transporter) return null;

    const appointmentDate = new Date(appointment.date + 'T00:00:00');
    const formattedDate = appointmentDate.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const [hours, minutes] = appointment.time.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    const formattedTime = `${displayHour}:${minutes} ${ampm}`;

    const emailHtml = `
    <!DOCTYPE html><html><head>
    <style>
        body { font-family: Georgia, serif; color: #333; line-height: 1.6; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #4a5240; color: white; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 24px; letter-spacing: 2px; font-weight: normal; }
        .content { padding: 30px; background: #f9f9f9; }
        .detail-row { display: flex; padding: 10px 0; border-bottom: 1px solid #eee; }
        .detail-label { font-weight: bold; width: 120px; color: #4a5240; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
    </style>
    </head><body>
    <div class="container">
        <div class="header"><h1>BRIGHT SMILE DENTAL</h1></div>
        <div class="content">
            <h2>Appointment Confirmed!</h2>
            <p>Dear ${appointment.firstName} ${appointment.lastName},</p>
            <p>Thank you for booking with Bright Smile Dental!</p>
            <div style="background:white;padding:20px;margin:20px 0;border-left:4px solid #4a5240;">
                <div class="detail-row"><span class="detail-label">Date:</span><span>${formattedDate}</span></div>
                <div class="detail-row"><span class="detail-label">Time:</span><span>${formattedTime}</span></div>
                <div class="detail-row"><span class="detail-label">Service:</span><span>${appointment.service}</span></div>
                <div class="detail-row"><span class="detail-label">Location:</span><span>${EMAIL_CONFIG.clinicAddress}</span></div>
            </div>
            <p>Questions? Call <strong>${EMAIL_CONFIG.clinicPhone}</strong></p>
        </div>
        <div class="footer"><p><strong>${EMAIL_CONFIG.clinicName}</strong> | ${EMAIL_CONFIG.clinicPhone}</p></div>
    </div>
    </body></html>`;

    try {
        const info = await transporter.sendMail({
            from: `"Bright Smile Dental" <noreply@brightsmile.com>`,
            to: appointment.email,
            subject: `Appointment Confirmed - ${formattedDate} at ${formattedTime}`,
            html: emailHtml
        });
        const previewUrl = nodemailer.getTestMessageUrl(info);
        if (previewUrl) console.log('Email preview:', previewUrl);
        return info;
    } catch (error) {
        console.error('Email error:', error);
        return null;
    }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'brightsmile-secret-2024',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Initialize database
async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS appointments (
            id SERIAL PRIMARY KEY,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT NOT NULL,
            service TEXT NOT NULL,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            notes TEXT DEFAULT '',
            status TEXT DEFAULT 'confirmed',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )
    `);
    await pool.query(`
        INSERT INTO admin_users (username, password)
        VALUES ('admin', 'brightsmile2024')
        ON CONFLICT (username) DO NOTHING
    `);
    console.log('Database initialized');
}

// Lazy init — runs once on first request
let initDone = false;
async function ensureInit() {
    if (initDone) return;
    await Promise.all([initDatabase(), initEmailTransporter()]);
    initDone = true;
}

app.use(async (req, res, next) => {
    try {
        await ensureInit();
        next();
    } catch (err) {
        console.error('Init error:', err);
        res.status(500).json({ error: 'Server initialization failed', details: err.message });
    }
});

// Clinic configuration
const CLINIC_CONFIG = { openTime: 9, closeTime: 17, slotDuration: 30, workDays: [1,2,3,4,5,6] };

function generateTimeSlots(date) {
    const slots = [];
    const dayOfWeek = new Date(date).getDay();
    if (!CLINIC_CONFIG.workDays.includes(dayOfWeek)) return slots;
    for (let hour = CLINIC_CONFIG.openTime; hour < CLINIC_CONFIG.closeTime; hour++) {
        for (let min = 0; min < 60; min += CLINIC_CONFIG.slotDuration) {
            slots.push(`${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`);
        }
    }
    return slots;
}

// ─── API Routes ────────────────────────────────────────────────────────────

app.get('/api/slots/:date', async (req, res) => {
    try {
        const { date } = req.params;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
        const selectedDate = new Date(date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (selectedDate < today) return res.status(400).json({ error: 'Cannot book in the past' });
        const allSlots = generateTimeSlots(date);
        const result = await pool.query(
            "SELECT time FROM appointments WHERE date = $1 AND status != 'cancelled'", [date]
        );
        const bookedTimes = result.rows.map(r => r.time);
        const availableSlots = allSlots.filter(s => !bookedTimes.includes(s));
        res.json({ date, allSlots, bookedSlots: bookedTimes, availableSlots });
    } catch (error) {
        console.error('Slots error:', error);
        res.status(500).json({ error: 'Failed to load time slots' });
    }
});

app.post('/api/appointments', async (req, res) => {
    try {
        const { firstName, lastName, email, phone, service, date, time, notes } = req.body;
        if (!firstName || !lastName || !email || !phone || !service || !date || !time) {
            return res.status(400).json({ error: 'All required fields must be filled' });
        }
        const existing = await pool.query(
            "SELECT id FROM appointments WHERE date = $1 AND time = $2 AND status != 'cancelled'",
            [date, time]
        );
        if (existing.rows.length > 0) return res.status(409).json({ error: 'This time slot is no longer available' });
        const result = await pool.query(
            `INSERT INTO appointments (first_name, last_name, email, phone, service, date, time, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [firstName, lastName, email, phone, service, date, time, notes || '']
        );
        const emailResult = await sendConfirmationEmail({ firstName, lastName, email, service, date, time });
        res.status(201).json({ success: true, message: 'Appointment booked!', appointmentId: result.rows[0].id, emailSent: !!emailResult });
    } catch (error) {
        console.error('Booking error:', error);
        res.status(500).json({ error: 'Failed to book appointment' });
    }
});

app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query(
            'SELECT * FROM admin_users WHERE username = $1 AND password = $2', [username, password]
        );
        if (result.rows.length > 0) {
            req.session.isAdmin = true;
            req.session.adminId = result.rows[0].id;
            res.json({ success: true, message: 'Login successful' });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logged out' });
});

app.get('/api/admin/check', (req, res) => {
    res.json({ isAuthenticated: !!req.session.isAdmin });
});

function requireAdmin(req, res, next) {
    if (req.session.isAdmin) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/admin/appointments', requireAdmin, async (req, res) => {
    try {
        const { date, status, search } = req.query;
        let query = 'SELECT * FROM appointments';
        const params = [];
        const conditions = [];
        if (date) { params.push(date); conditions.push(`date = $${params.length}`); }
        if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
        if (search) {
            params.push(`%${search.toLowerCase()}%`);
            const idx = params.length;
            conditions.push(`(LOWER(first_name) LIKE $${idx} OR LOWER(last_name) LIKE $${idx} OR LOWER(email) LIKE $${idx} OR LOWER(phone) LIKE $${idx})`);
        }
        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY date DESC, time ASC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch appointments' });
    }
});

app.get('/api/admin/patient-history/:email', requireAdmin, async (req, res) => {
    try {
        const { email } = req.params;
        const result = await pool.query(
            'SELECT * FROM appointments WHERE email = $1 ORDER BY date DESC, time DESC', [email]
        );
        const appointments = result.rows;
        const patient = appointments.length > 0 ? {
            firstName: appointments[0].first_name,
            lastName: appointments[0].last_name,
            email: appointments[0].email,
            phone: appointments[0].phone,
            totalAppointments: appointments.length,
            completedAppointments: appointments.filter(a => a.status === 'completed').length,
            cancelledAppointments: appointments.filter(a => a.status === 'cancelled').length,
            noShows: appointments.filter(a => a.status === 'no-show').length
        } : null;
        res.json({ patient, appointments });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch patient history' });
    }
});

app.get('/api/admin/patients', requireAdmin, async (req, res) => {
    try {
        const { search } = req.query;
        let query = `SELECT email, first_name, last_name, phone,
                     COUNT(*) as total_appointments, MAX(date) as last_visit
                     FROM appointments`;
        const params = [];
        if (search) {
            params.push(`%${search.toLowerCase()}%`);
            query += ` WHERE LOWER(first_name) LIKE $1 OR LOWER(last_name) LIKE $1 OR LOWER(email) LIKE $1 OR LOWER(phone) LIKE $1`;
        }
        query += ' GROUP BY email, first_name, last_name, phone ORDER BY last_visit DESC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch patients' });
    }
});

app.patch('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const validStatuses = ['confirmed', 'completed', 'cancelled', 'no-show'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        await pool.query('UPDATE appointments SET status = $1 WHERE id = $2', [status, parseInt(id)]);
        res.json({ success: true, message: 'Appointment updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update appointment' });
    }
});

app.delete('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM appointments WHERE id = $1', [parseInt(id)]);
        res.json({ success: true, message: 'Appointment deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete appointment' });
    }
});

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/before-after', (req, res) => res.sendFile(path.join(__dirname, 'public', 'before-after.html')));
app.get('/book', (req, res) => res.sendFile(path.join(__dirname, 'public', 'book-appointment.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Export for Vercel serverless
module.exports = app;

// Start server for local development
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`
    ====================================
    Bright Smile Dental Server Running!
    ====================================
    Website:     http://localhost:${PORT}
    Admin Panel: http://localhost:${PORT}/admin
    Admin Login: admin / brightsmile2024
    ====================================
        `);
    });
}
