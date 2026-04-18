const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
const router = express.Router();

const port = Number(process.env.PORT) || 3300;
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'trackzero'
};

// Keep this simple for teammates: set AUTO_SETUP_DB=false if DB team wants to manage schema manually.
const autoSetupDatabase = process.env.AUTO_SETUP_DB !== 'false';

const fallbackAdminUsername = process.env.ADMIN_USERNAME || 'admin1';
const fallbackAdminPassword = process.env.ADMIN_PASSWORD || 'pass123';
const adminApiToken = process.env.ADMIN_API_TOKEN || 'trackzero-admin-token';
const adminCookieName = 'trackzero_admin';
const cookieSecure = process.env.NODE_ENV === 'production';

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500,http://localhost:3300')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

let pool = null;

app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

app.use(express.static(path.join(__dirname, 'html')));
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
router.use(cookieParser());
app.use(router);

function sendPage(res, fileName) {
    res.sendFile(path.join(__dirname, 'html', fileName));
}

function sendError(res, statusCode, message) {
    res.status(statusCode).json({
        success: false,
        message
    });
}

function parseTrackList(rawTrackList) {
    if (!rawTrackList) {
        return [];
    }

    try {
        const parsed = JSON.parse(rawTrackList);
        if (Array.isArray(parsed)) {
            return parsed;
        }
    } catch (error) {
        // If DB stores comma-separated values instead of JSON, split by comma.
    }

    return String(rawTrackList)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function normalizeProduct(row) {
    return {
        id: row.id,
        name: row.name,
        artist: row.artist,
        genre: row.genre,
        format: row.format,
        year: row.year,
        description: row.description,
        imageUrl: row.image_url,
        trackList: parseTrackList(row.track_list)
    };
}

function validateProductInput(body) {
    const name = String(body.name || '').trim();
    const artist = String(body.artist || '').trim();
    const genre = String(body.genre || '').trim();
    const format = String(body.format || '').trim();
    const yearValue = Number(body.year);
    const description = String(body.description || '').trim();
    const imageUrl = String(body.imageUrl || '').trim();

    if (!name || !artist || !genre || !format || !body.year) {
        return { error: 'Name, artist, genre, format, and year are required.' };
    }

    if (!Number.isInteger(yearValue) || yearValue < 1900 || yearValue > 2100) {
        return { error: 'Year must be a whole number between 1900 and 2100.' };
    }

    let trackList = [];
    if (Array.isArray(body.trackList)) {
        trackList = body.trackList
            .map((item) => String(item).trim())
            .filter((item) => item.length > 0);
    } else {
        trackList = String(body.trackList || '')
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }

    return {
        product: {
            name,
            artist,
            genre,
            format,
            year: yearValue,
            description,
            imageUrl,
            trackList
        }
    };
}

function getAdminTokenFromRequest(req) {
    const headerToken = String(req.headers['x-admin-token'] || '').trim();
    const cookieToken = String(req.cookies[adminCookieName] || '').trim();

    if (headerToken) {
        return headerToken;
    }

    return cookieToken;
}

function requireDatabase(req, res, next) {
    if (!pool) {
        return sendError(res, 503, 'Database is not connected yet.');
    }
    next();
}

function requireAdmin(req, res, next) {
    const token = getAdminTokenFromRequest(req);

    if (token !== adminApiToken) {
        return sendError(res, 401, 'Admin login required.');
    }

    next();
}

async function findAdminCredentialByUsername(username) {
    const [rows] = await pool.query(
        `
        SELECT
            ac.id AS credential_id,
            ac.username,
            ac.password,
            ac.role,
            a.id AS admin_id,
            a.first_name,
            a.last_name,
            a.address,
            a.age,
            a.email
        FROM admin_credentials ac
        JOIN administrators a ON a.id = ac.admin_id
        WHERE ac.username = ?
        LIMIT 1
        `,
        [username]
    );

    return rows[0] || null;
}

async function writeLoginLog(username, status, credentialId, ipAddress) {
    try {
        await pool.query(
            `
            INSERT INTO admin_login_logs
            (credential_id, username, status, ip_address)
            VALUES (?, ?, ?, ?)
            `,
            [credentialId || null, username, status, ipAddress || null]
        );
    } catch (error) {
        console.log('Skip login log insert:', error.message);
    }
}

async function seedAdministrators() {
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM administrators');
    if (countRows[0].total > 0) {
        return;
    }

    const admins = [
        ['Anan', 'Sukjai', 'Bangkok', 29, 'anan@trackzero.local'],
        ['Nida', 'Siriluck', 'Chiang Mai', 31, 'nida@trackzero.local'],
        ['Korn', 'Phasuk', 'Khon Kaen', 35, 'korn@trackzero.local'],
        ['Pim', 'Rattanakul', 'Phuket', 27, 'pim@trackzero.local'],
        ['Pat', 'Wongsa', 'Nakhon Pathom', 30, 'pat@trackzero.local'],
        ['Mook', 'Lertsri', 'Ayutthaya', 34, 'mook@trackzero.local'],
        ['Win', 'Maneerat', 'Songkhla', 26, 'win@trackzero.local'],
        ['Beam', 'Thananon', 'Chonburi', 32, 'beam@trackzero.local'],
        ['Ice', 'Nuntiya', 'Rayong', 28, 'ice@trackzero.local'],
        ['Bank', 'Jaturon', 'Udon Thani', 33, 'bank@trackzero.local']
    ];

    await pool.query(
        `
        INSERT INTO administrators (first_name, last_name, address, age, email)
        VALUES ?
        `,
        [admins]
    );
}

async function seedAdminCredentials() {
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM admin_credentials');
    if (countRows[0].total > 0) {
        return;
    }

    const [adminRows] = await pool.query('SELECT id FROM administrators ORDER BY id ASC LIMIT 10');

    if (adminRows.length === 0) {
        return;
    }

    const credentials = adminRows.map((admin, index) => [
        admin.id,
        `admin${index + 1}`,
        'pass123',
        index < 2 ? 'superadmin' : 'admin'
    ]);

    await pool.query(
        `
        INSERT INTO admin_credentials (admin_id, username, password, role)
        VALUES ?
        `,
        [credentials]
    );
}

async function seedLoginLogs() {
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM admin_login_logs');
    if (countRows[0].total > 0) {
        return;
    }

    const [credentialRows] = await pool.query('SELECT id, username FROM admin_credentials ORDER BY id ASC LIMIT 10');

    if (credentialRows.length === 0) {
        return;
    }

    const logs = credentialRows.map((credential, index) => [
        credential.id,
        credential.username,
        index % 2 === 0 ? 'SUCCESS' : 'FAILED',
        '127.0.0.1'
    ]);

    await pool.query(
        `
        INSERT INTO admin_login_logs (credential_id, username, status, ip_address)
        VALUES ?
        `,
        [logs]
    );
}

async function seedProducts() {
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM products');
    if (countRows[0].total > 0) {
        return;
    }

    const products = [
        [
            'This outstanding object',
            'The Artist Name',
            'Rock',
            'Vinyl',
            2024,
            'A featured rock vinyl release.',
            'https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Track 1', 'Track 2', 'Track 3'])
        ],
        [
            'This astounding article',
            'Another Artist',
            'Pop',
            'CD',
            2023,
            'Popular CD album for daily listening.',
            'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Song A', 'Song B', 'Song C'])
        ],
        [
            'This brilliant bit',
            'City Lights',
            'Rock',
            'Cassette',
            2022,
            'Collector cassette with vintage sound.',
            'https://images.unsplash.com/photo-1471478331149-c72f17e33c73?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Side A', 'Side B'])
        ],
        [
            'Neon Midnight',
            'Retro Pulse',
            'Electronic',
            'Digital Albums',
            2021,
            'Synthwave tracks for night drives.',
            'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Neon Intro', 'Highway Star', 'Final Lights'])
        ],
        [
            'Morning Echoes',
            'Luna Field',
            'Indie',
            'Vinyl',
            2020,
            'Soft indie collection for relaxing mornings.',
            'https://images.unsplash.com/photo-1464375117522-1311dd6a6f0f?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Daybreak', 'Paper Sky', 'Golden Hour'])
        ],
        [
            'Studio Sessions',
            'Blue River',
            'Jazz',
            'CD',
            2019,
            'Live studio jazz session recordings.',
            'https://images.unsplash.com/photo-1516280030429-27679b3dc9cf?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Session One', 'Session Two', 'Session Three'])
        ],
        [
            'Rain Tape',
            'Cloud Motel',
            'Lo-fi',
            'Cassette',
            2024,
            'Lo-fi cassette release with analog noise texture.',
            'https://images.unsplash.com/photo-1452723312111-3a7d0db0e024?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Drizzle', 'Late Bus', 'Coffee Shop'])
        ],
        [
            'Festival Live',
            'Sparks',
            'Pop',
            'Digital Albums',
            2022,
            'Recorded live at summer festival.',
            'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Opening Fire', 'Crowd Waves', 'Encore'])
        ],
        [
            'The Long Road',
            'Highway Club',
            'Country',
            'CD',
            2018,
            'Country road songs and acoustic stories.',
            'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Dust Lane', 'Old Truck', 'Home'])
        ],
        [
            'Orbit Dreams',
            'Nova Kids',
            'Electronic',
            'Vinyl',
            2025,
            'Space-themed electronic album on vinyl.',
            'https://images.unsplash.com/photo-1445985543470-41fba5c3144a?auto=format&fit=crop&w=900&q=80',
            JSON.stringify(['Launch', 'Zero Gravity', 'Re-entry'])
        ]
    ];

    await pool.query(
        `
        INSERT INTO products
        (name, artist, genre, format, year, description, image_url, track_list)
        VALUES ?
        `,
        [products]
    );
}

async function initializeDatabase() {
    pool = mysql.createPool({
        ...dbConfig,
        connectionLimit: 5,
        waitForConnections: true,
        queueLimit: 0
    });

    await pool.query('SELECT 1');

    if (!autoSetupDatabase) {
        console.log('AUTO_SETUP_DB=false. Skip table create/seed.');
        return;
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS administrators (
            id INT AUTO_INCREMENT PRIMARY KEY,
            first_name VARCHAR(100) NOT NULL,
            last_name VARCHAR(100) NOT NULL,
            address VARCHAR(255),
            age INT,
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_credentials (
            id INT AUTO_INCREMENT PRIMARY KEY,
            admin_id INT NOT NULL,
            username VARCHAR(100) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            role VARCHAR(50) NOT NULL DEFAULT 'admin',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (admin_id) REFERENCES administrators(id) ON DELETE CASCADE
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_login_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            credential_id INT NULL,
            username VARCHAR(100) NOT NULL,
            status VARCHAR(20) NOT NULL,
            ip_address VARCHAR(100),
            logged_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (credential_id) REFERENCES admin_credentials(id) ON DELETE SET NULL
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS products (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            artist VARCHAR(255) NOT NULL,
            genre VARCHAR(100) NOT NULL,
            format VARCHAR(100) NOT NULL,
            year INT NOT NULL,
            description TEXT,
            image_url TEXT,
            track_list TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    await seedAdministrators();
    await seedAdminCredentials();
    await seedLoginLogs();
    await seedProducts();
}

initializeDatabase()
    .then(() => {
        console.log('Database ready.');
    })
    .catch((error) => {
        pool = null;
        console.error('Database initialization failed:', error.message);
    });

router.get('/', (req, res) => {
    sendPage(res, 'Home.html');
});

router.get('/Login', (req, res) => {
    sendPage(res, 'Login.html');
});

router.get('/Team', (req, res) => {
    sendPage(res, 'Team.html');
});

router.get('/Search', (req, res) => {
    sendPage(res, 'Search.html');
});

router.get('/Manage-Products', (req, res) => {
    sendPage(res, 'productservice-management.html');
});

router.get('/Detail', (req, res) => {
    sendPage(res, 'Detail.html');
});

router.get('/detail-adminview', (req, res) => {
    sendPage(res, 'Detail-adminview.html');
});

router.get('/login-cookie', (req, res) => {
    res.redirect('/Login');
});

// Service 1: Authentication web service for administrators
// Test case 1:
// method: POST
// URL: http://localhost:3300/api/auth/login
// body: {"username":"admin1", "password":"pass123", "rememberMe":true}
// expected: 200, success=true, token is returned.
// Test case 2:
// method: POST
// URL: http://localhost:3300/api/auth/login
// body: {"username":"admin1", "password":"wrong"}
// expected: 401, success=false.
router.post('/api/auth/login', async (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');
        const rememberMe = Boolean(req.body.rememberMe);

        if (!username || !password) {
            return sendError(res, 400, 'Username and password are required.');
        }

        let credential = null;
        if (pool) {
            try {
                credential = await findAdminCredentialByUsername(username);
            } catch (error) {
                console.log('Admin credential lookup skipped:', error.message);
            }
        }

        let isValid = false;
        let role = 'admin';
        let credentialId = null;
        let adminProfile = null;

        if (credential) {
            isValid = password === credential.password;
            role = credential.role;
            credentialId = credential.credential_id;
            adminProfile = {
                id: credential.admin_id,
                firstName: credential.first_name,
                lastName: credential.last_name,
                address: credential.address,
                age: credential.age,
                email: credential.email
            };
        } else {
            isValid = username === fallbackAdminUsername && password === fallbackAdminPassword;
        }

        if (pool) {
            await writeLoginLog(username, isValid ? 'SUCCESS' : 'FAILED', credentialId, req.ip);
        }

        if (!isValid) {
            return sendError(res, 401, 'Invalid username or password.');
        }

        const maxAge = rememberMe ? 1000 * 60 * 60 * 24 * 7 : 1000 * 60 * 60 * 2;

        res.cookie(adminCookieName, adminApiToken, {
            httpOnly: true,
            sameSite: 'lax',
            secure: cookieSecure,
            maxAge
        });

        res.json({
            success: true,
            message: 'Login successful.',
            token: adminApiToken,
            role,
            admin: adminProfile
        });
    } catch (error) {
        console.error('Login failed:', error.message);
        sendError(res, 500, 'Could not process login.');
    }
});

// Service 1: Authentication web service for administrators
// Test case 1:
// method: POST
// URL: http://localhost:3300/api/auth/logout
// expected: 200, success=true and cookie cleared.
// Test case 2:
// method: GET
// URL: http://localhost:3300/api/auth/status
// expected: 200 with isAdmin=true after login and false without token.
router.post('/api/auth/logout', (req, res) => {
    res.clearCookie(adminCookieName, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure
    });

    res.json({
        success: true,
        message: 'Logout successful.'
    });
});

router.get('/api/auth/status', (req, res) => {
    const token = getAdminTokenFromRequest(req);
    const isAdmin = token === adminApiToken;

    res.json({
        success: true,
        isAdmin
    });
});

router.get('/api/admin/login-logs', requireDatabase, requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `
            SELECT id, username, status, ip_address AS ipAddress, logged_in_at AS loggedInAt
            FROM admin_login_logs
            ORDER BY id DESC
            LIMIT 50
            `
        );

        res.json({
            success: true,
            count: rows.length,
            data: rows
        });
    } catch (error) {
        console.error('Get login logs failed:', error.message);
        sendError(res, 500, 'Could not load login logs.');
    }
});

// Service 2: Product/Service Search and Details
// Test case 1:
// method: GET
// URL: http://localhost:3300/api/products
// expected: 200 and all products.
// Test case 2:
// method: GET
// URL: http://localhost:3300/api/products?name=object&genre=Rock&artist=The%20Artist%20Name
// expected: 200 and filtered results based on criteria.
router.get('/api/products', requireDatabase, async (req, res) => {
    try {
        const name = String(req.query.name || '').trim();
        const genre = String(req.query.genre || '').trim();
        const artist = String(req.query.artist || '').trim();
        const year = String(req.query.year || '').trim();
        const format = String(req.query.format || '').trim();

        const whereParts = [];
        const values = [];

        if (name) {
            whereParts.push('name LIKE ?');
            values.push(`%${name}%`);
        }
        if (genre) {
            whereParts.push('genre = ?');
            values.push(genre);
        }
        if (artist) {
            whereParts.push('artist = ?');
            values.push(artist);
        }
        if (year) {
            const yearNumber = Number(year);
            if (!Number.isInteger(yearNumber)) {
                return sendError(res, 400, 'Year must be a number.');
            }
            whereParts.push('year = ?');
            values.push(yearNumber);
        }
        if (format) {
            whereParts.push('format = ?');
            values.push(format);
        }

        let sql = 'SELECT * FROM products';
        if (whereParts.length > 0) {
            sql += ` WHERE ${whereParts.join(' AND ')}`;
        }
        sql += ' ORDER BY id DESC';

        const [rows] = await pool.query(sql, values);

        res.json({
            success: true,
            count: rows.length,
            data: rows.map(normalizeProduct)
        });
    } catch (error) {
        console.error('Search products failed:', error.message);
        sendError(res, 500, 'Could not search products.');
    }
});

// Service 2: Product/Service Search and Details
// Test case 1:
// method: GET
// URL: http://localhost:3300/api/products/1
// expected: 200 and one product object.
// Test case 2:
// method: GET
// URL: http://localhost:3300/api/products/999999
// expected: 404 and product not found.
router.get('/api/products/:id', requireDatabase, async (req, res) => {
    try {
        const productId = Number(req.params.id);

        if (!Number.isInteger(productId) || productId < 1) {
            return sendError(res, 400, 'Invalid product id.');
        }

        const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [productId]);

        if (rows.length === 0) {
            return sendError(res, 404, 'Product not found.');
        }

        res.json({
            success: true,
            data: normalizeProduct(rows[0])
        });
    } catch (error) {
        console.error('Get product detail failed:', error.message);
        sendError(res, 500, 'Could not load product detail.');
    }
});

// Service 3: Product/Service Management for administrators (Insert)
// Test case 1:
// method: POST
// URL: http://localhost:3300/api/admin/products
// header: X-Admin-Token: trackzero-admin-token
// body: {"name":"New Album","artist":"Demo Artist","genre":"Rock","format":"CD","year":2026}
// expected: 201 and new product returned.
// Test case 2:
// method: POST
// URL: http://localhost:3300/api/admin/products
// body: {"name":"No Auth"}
// expected: 401 when token is missing.
router.post('/api/admin/products', requireDatabase, requireAdmin, async (req, res) => {
    try {
        const validation = validateProductInput(req.body);
        if (validation.error) {
            return sendError(res, 400, validation.error);
        }

        const product = validation.product;

        const [insertResult] = await pool.query(
            `
            INSERT INTO products
            (name, artist, genre, format, year, description, image_url, track_list)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                product.name,
                product.artist,
                product.genre,
                product.format,
                product.year,
                product.description,
                product.imageUrl,
                JSON.stringify(product.trackList)
            ]
        );

        const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [insertResult.insertId]);

        res.status(201).json({
            success: true,
            message: 'Product created successfully.',
            data: normalizeProduct(rows[0])
        });
    } catch (error) {
        console.error('Create product failed:', error.message);
        sendError(res, 500, 'Could not create product.');
    }
});

// Service 3: Product/Service Management for administrators (Update)
// Test case 1:
// method: PUT
// URL: http://localhost:3300/api/admin/products/1
// header: X-Admin-Token: trackzero-admin-token
// body: {"name":"Updated Album","artist":"Demo Artist","genre":"Rock","format":"Vinyl","year":2026}
// expected: 200 and updated product.
// Test case 2:
// method: PUT
// URL: http://localhost:3300/api/admin/products/999999
// header: X-Admin-Token: trackzero-admin-token
// expected: 404 when id is not found.
router.put('/api/admin/products/:id', requireDatabase, requireAdmin, async (req, res) => {
    try {
        const productId = Number(req.params.id);

        if (!Number.isInteger(productId) || productId < 1) {
            return sendError(res, 400, 'Invalid product id.');
        }

        const validation = validateProductInput(req.body);
        if (validation.error) {
            return sendError(res, 400, validation.error);
        }

        const [existingRows] = await pool.query('SELECT id FROM products WHERE id = ?', [productId]);
        if (existingRows.length === 0) {
            return sendError(res, 404, 'Product not found.');
        }

        const product = validation.product;

        await pool.query(
            `
            UPDATE products
            SET name = ?, artist = ?, genre = ?, format = ?, year = ?, description = ?, image_url = ?, track_list = ?
            WHERE id = ?
            `,
            [
                product.name,
                product.artist,
                product.genre,
                product.format,
                product.year,
                product.description,
                product.imageUrl,
                JSON.stringify(product.trackList),
                productId
            ]
        );

        const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [productId]);

        res.json({
            success: true,
            message: 'Product updated successfully.',
            data: normalizeProduct(rows[0])
        });
    } catch (error) {
        console.error('Update product failed:', error.message);
        sendError(res, 500, 'Could not update product.');
    }
});

// Service 3: Product/Service Management for administrators (Delete)
// Test case 1:
// method: DELETE
// URL: http://localhost:3300/api/admin/products/1
// header: X-Admin-Token: trackzero-admin-token
// expected: 200 and delete success.
// Test case 2:
// method: DELETE
// URL: http://localhost:3300/api/admin/products/1
// expected: 401 when token is missing.
router.delete('/api/admin/products/:id', requireDatabase, requireAdmin, async (req, res) => {
    try {
        const productId = Number(req.params.id);

        if (!Number.isInteger(productId) || productId < 1) {
            return sendError(res, 400, 'Invalid product id.');
        }

        const [deleteResult] = await pool.query('DELETE FROM products WHERE id = ?', [productId]);

        if (deleteResult.affectedRows === 0) {
            return sendError(res, 404, 'Product not found.');
        }

        res.json({
            success: true,
            message: 'Product deleted successfully.'
        });
    } catch (error) {
        console.error('Delete product failed:', error.message);
        sendError(res, 500, 'Could not delete product.');
    }
});

app.listen(port, () => {
    console.log(`Server listening on port: ${port}`);
});
