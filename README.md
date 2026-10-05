#  Smart Parking & Automatic License Plate Recognition System

An AI-enabled smart parking management platform that combines **web-based parking management, real-time occupancy tracking, automatic license plate recognition (ALPR/OCR), reservations, payments, wallet management, and administrative controls**.

The system is designed to automate the parking workflow from vehicle identification and slot allocation to booking, payment, entry, exit, and occupancy management.

---

##  Key Features

###  User Management

* User registration and authentication
* JWT-based authentication
* Role-based authorization
* Vehicle registration and management
* User parking history
* Secure password handling
* Authentication rate limiting

###  Smart Parking Management

* Real-time parking slot availability
* Parking slot allocation
* Time-based parking reservations
* Booking lifecycle management
* Automatic expiration of pending bookings
* Parking occupancy tracking
* Prevention of conflicting reservations

###  Automatic License Plate Recognition

The system integrates camera-based vehicle detection with an OCR/ALPR pipeline.

```text
Camera
   ↓
Vehicle / Plate Detection
   ↓
Image Preprocessing
   ↓
OCR
   ↓
License Plate Extraction
   ↓
Plate Normalization
   ↓
Confidence Validation
   ↓
Backend API
   ↓
Vehicle / Booking Verification
   ↓
Parking Entry / Exit
```

The ALPR service is designed to handle:

* License plate detection
* OCR-based plate recognition
* Image preprocessing
* Plate normalization
* OCR confidence validation
* Duplicate detection handling
* Backend integration
* Authenticated internal ALPR communication

###  Payments & Wallet

* Razorpay payment integration
* Server-side payment amount validation
* Payment verification
* Wallet top-ups
* Wallet transaction history
* Duplicate payment protection
* Cash payment workflow
* Payment status tracking

> Payment amounts are calculated and validated on the server instead of trusting values supplied by the frontend.

###  Real-Time Updates

The system uses **Socket.IO** for real-time communication.

Parking availability and occupancy changes can be propagated to connected clients without requiring a page refresh.

###  Admin Dashboard

Administrators can manage:

* Parking slots
* Users
* Vehicles
* Bookings
* Payments
* Parking occupancy
* Administrative operations

###  Notifications

The backend includes SMS integration for parking-related notifications where configured.

###  Security

Security considerations implemented in the project include:

* JWT authentication
* Password hashing
* Role-based authorization
* API rate limiting
* Protected ALPR endpoints
* Environment-based secrets
* Server-side payment validation
* Payment replay/duplicate protection
* Database transaction controls
* Booking concurrency protection
* Input validation
* Separation of test utilities from production workflows

---

#  System Architecture

```text
                         ┌──────────────────────┐
                         │      Frontend        │
                         │  HTML / CSS / JS     │
                         └──────────┬───────────┘
                                    │
                                    │ REST API
                                    ▼
                         ┌──────────────────────┐
                         │   Node.js / Express  │
                         │      Backend         │
                         └──────┬───────┬───────┘
                                │       │
                ┌───────────────┘       └────────────────┐
                │                                        │
                ▼                                        ▼
       ┌─────────────────┐                    ┌─────────────────┐
       │   PostgreSQL    │                    │    Razorpay     │
       │    Database     │                    │    Payments     │
       └─────────────────┘                    └─────────────────┘
                │
                │
                ▼
       ┌─────────────────┐
       │ Booking /       │
       │ Occupancy Logic │
       └─────────────────┘


        Camera
           │
           ▼
 ┌─────────────────────┐
 │ Python Camera       │
 │ Integration         │
 └──────────┬──────────┘
            │
            ▼
 ┌─────────────────────┐
 │ OCR / ALPR Service  │
 │       Python        │
 └──────────┬──────────┘
            │
            ▼
 ┌─────────────────────┐
 │ Authenticated       │
 │ Backend API         │
 └─────────────────────┘
```

---

#  Technology Stack

## Frontend

* HTML5
* CSS3
* JavaScript
* Socket.IO Client

## Backend

* Node.js
* Express.js
* REST APIs
* Socket.IO
* JWT
* bcrypt

## Database

* PostgreSQL
* SQL transactions
* Database constraints
* Row-level locking

## AI / Computer Vision

* Python
* OCR
* Tesseract
* Image preprocessing
* Automatic License Plate Recognition (ALPR)
* Camera integration

## Payments

* Razorpay

## Notifications

* SMS API integration

## Testing

* Node.js testing tools
* Security and authentication tests

---

#  Project Structure

```text
Smart-Parking-System/
│
├── frontend/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── admin.html
│   ├── admin.js
│   └── admin-styles.css
│
├── server/
│   ├── server.js
│   ├── db.js
│   │
│   ├── routes/
│   │   ├── auth.js
│   │   ├── vehicles.js
│   │   ├── bookings.js
│   │   ├── parking.js
│   │   ├── payments.js
│   │   ├── admin.js
│   │   └── alpr.js
│   │
│   ├── middleware/
│   │   ├── auth.js
│   │   └── rateLimit.js
│   │
│   ├── jobs/
│   │   ├── scheduler.js
│   │   └── overdueBookings.js
│   │
│   └── utils/
│       └── sms.js
│
├── database/
│   ├── schema.sql
│   └── migrations/
│
├── camera-integration/
│   ├── parking_detection.py
│   ├── requirements.txt
│   └── .env.example
│
├── ocr-service/
│   ├── ocr_service.py
│   └── requirements.txt
│
├── tests/
│   └── security.test.js
│
├── matlab-integration/
│   └── parking_detection.m
│
├── create-admin.js
├── package.json
├── package-lock.json
├── .env.example
└── .gitignore
```

---

#  Installation

## 1. Clone the repository

```bash
git clone https://github.com/surjeetmaini8/Smart-Parking-System.git
cd Smart-Parking-System
```

---

## 2. Install Node.js dependencies

```bash
npm install
```

---

## 3. Configure environment variables

Create a `.env` file from the example:

### Windows

```powershell
Copy-Item .env.example .env
```

### Linux / macOS

```bash
cp .env.example .env
```

Then configure the required values.

Example:

```env
PORT=4000

DB_HOST=localhost
DB_PORT=5432
DB_NAME=smart_parking
DB_USER=your_database_user
DB_PASSWORD=your_database_password

JWT_SECRET=your_long_random_secret

RAZORPAY_KEY_ID=your_key_id
RAZORPAY_KEY_SECRET=your_key_secret

ALPR_INTERNAL_TOKEN=your_internal_alpr_token
```

> **Never commit the real `.env` file to GitHub.**

Only `.env.example` should be committed.

---

#  Database Setup

Create a PostgreSQL database:

```sql
CREATE DATABASE smart_parking;
```

Run the database schema:

```bash
psql -U your_database_user -d smart_parking -f database/schema.sql
```

Then apply the required migrations:

```bash
psql -U your_database_user -d smart_parking -f database/migrations/001_security_and_integrity.sql
```

Make sure the PostgreSQL server is running before starting the application.

---

#  Create an Administrator

Use the administrator setup script:

```bash
node create-admin.js
```

Follow the prompts to create the initial admin account.

---

#  Camera / ALPR Setup

Navigate to:

```bash
cd camera-integration
```

Create a Python virtual environment:

### Windows

```powershell
python -m venv venv
venv\Scripts\activate
```

### Linux / macOS

```bash
python3 -m venv venv
source venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Configure the camera-related environment variables using:

```text
camera-integration/.env.example
```

---

#  OCR Service Setup

Navigate to:

```bash
cd ocr-service
```

Install Python dependencies:

```bash
pip install -r requirements.txt
```

The OCR service requires a working Tesseract installation.

Verify Tesseract:

```bash
tesseract --version
```

If Tesseract is not installed, install it for your operating system and ensure it is available in the system PATH or configure its executable location through the service configuration.

---

# ▶️ Running the Application

From the project root:

```bash
npm start
```

The backend will start on the configured port.

For example:

```text
http://localhost:4000
```

Open the frontend through the configured application server.

---

#  Parking Workflow

The typical parking workflow is:

```text
User
 │
 ├── Register
 │
 ├── Add Vehicle
 │
 ├── View Parking Availability
 │
 ├── Select Parking Slot
 │
 ├── Create Reservation
 │
 ├── Make Payment
 │
 ▼
Parking Reservation
 │
 ▼
Vehicle Arrives
 │
 ▼
Camera / ALPR
 │
 ▼
License Plate Recognition
 │
 ▼
Vehicle Verification
 │
 ▼
Entry
 │
 ▼
Parking Occupancy Updated
 │
 ▼
Vehicle Exit
 │
 ▼
Exit Verification
 │
 ▼
Parking Slot Released
 │
 ▼
Real-Time Availability Updated
```

---

#  Security Architecture

The system uses multiple layers of security.

### Authentication

```text
User
 ↓
Login
 ↓
Password Verification
 ↓
JWT
 ↓
Protected API
```

### Authorization

Protected endpoints verify:

* Authentication
* User identity
* User role
* Resource ownership

### ALPR Security

The ALPR service uses an internal authentication token so external clients cannot freely submit camera events.

### Payment Security

The backend:

1. Calculates the expected amount.
2. Creates/verifies the payment.
3. Validates the payment response.
4. Prevents duplicate processing.
5. Records the transaction.

---

#  Booking Concurrency

One important engineering problem in parking systems is concurrent booking.

For example:

```text
User A ───────┐
              │
              ▼
          Slot A1
              ▲
              │
User B ───────┘
```

Both users may attempt to reserve the same slot simultaneously.

The backend uses PostgreSQL transaction mechanisms and database constraints to prevent conflicting reservations.

Conceptually:

```text
Request A ──┐
            ├── PostgreSQL Transaction
Request B ──┘
                  │
                  ▼
             Slot Validation
                  │
          ┌───────┴────────┐
          ▼                ▼
       Allowed           Rejected
```

This prevents application-level race conditions from creating invalid bookings.

---

# ⚡ Real-Time Updates

Socket.IO is used to communicate parking-state changes to connected clients.

For example:

```text
Parking Slot A1
     │
     ▼
Occupancy Change
     │
     ▼
Backend
     │
     ▼
Socket.IO
     │
     ├──────────► User Dashboard
     │
     └──────────► Admin Dashboard
```

---



#  Environment Variables

Never commit production secrets.


###  Commit

```text
.env.example
```

The `.env.example` file should contain placeholders only:

```env
JWT_SECRET=your_secret_here
RAZORPAY_KEY_ID=your_key_here
RAZORPAY_KEY_SECRET=your_secret_here
```

If a real secret is accidentally exposed publicly, revoke/rotate it immediately.

---

#  Database Concepts

The database supports entities such as:

* Users
* Vehicles
* Parking locations
* Parking slots
* Bookings
* Payments
* Wallet transactions
* Occupancy events

The database uses transactional operations and integrity constraints to maintain consistent parking and payment state.

---

#  Production Considerations

For production deployment, the following improvements are recommended:

* HTTPS/TLS
* Secure HttpOnly authentication cookies
* Redis for distributed rate limiting/session state
* Centralized logging
* Application monitoring
* Error tracking
* Database connection pooling
* Automated database backups
* Payment webhooks
* Payment refund/reconciliation workflows
* Background job queue
* Containerized deployment
* CI/CD pipeline
* Improved ALPR model with dedicated object detection
* Human verification for low-confidence plate recognition
* Load testing

---

#  Future Improvements

Potential future versions can include:

### AI / ML

* YOLO-based vehicle and license plate detection
* Better OCR preprocessing
* Multi-frame plate recognition
* Confidence-based recognition
* Automatic false-positive filtering
* Vehicle classification
* Parking occupancy prediction
* Demand forecasting
* Dynamic parking pricing

### Backend

* Redis caching
* Message queues
* Microservice separation where justified
* Distributed job processing
* Better observability

### User Experience

* Mobile application
* QR-based parking entry
* Digital parking pass
* Navigation to assigned parking slot
* Reservation reminders
* Push notifications

### Analytics

* Parking utilization dashboard
* Peak-hour analysis
* Revenue analytics
* Average parking duration
* Slot utilization
* Vehicle frequency analysis

---

#  Project Highlights

This project demonstrates practical experience in:

* Full-stack web development
* REST API development
* PostgreSQL database design
* Transaction management
* Concurrent booking prevention
* Authentication and authorization
* Payment integration
* Real-time communication
* Computer vision
* OCR / ALPR
* Camera integration
* Backend security
* Automated testing
* Background job processing

---

#  Author

**Surjeet Maini**

GitHub:
https://github.com/surjeetmaini8

Project:
https://github.com/surjeetmaini8/Smart-Parking-System

---

#  License

This project is intended for educational, research, and development purposes.

Add an appropriate open-source license if you plan to distribute or reuse the project publicly.
