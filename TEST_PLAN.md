Purpose

This document lists manual and automated test cases to validate the A1 Fitness backend auth, seeding, and member workflows before handing the app to your client.

What this covers

- Default admin bootstrap on fresh DB
- Signup flow: member-only signup, pending status, no dashboard access
- Login flow: blocking pending/inactive accounts
- Admin actions: approve member, create trainers, manage members
- Trainer actions: view assigned members, assign workout/diet
- Member actions: view profile, submit reset password
- Safety: no destructive seeding (no deletes run on startup)

Quick start (dev)

- Ensure `.env` has `MONGO_URI` and `PORT` set.
- Start server:

  npm run dev

- Health check:

  curl -s http://localhost:5000/api/health | jq .

Expect `adminExists` true after first seed-run (or when an admin already exists).

Test data and credentials

- Default Admin (seeded if no admin exists):
  - Gym ID: `MAIN`
  - Email: `shivadas01635@gmail.com`
  - Password: `a1fitness2026`

Manual test checklist

1) Fresh DB / default admin
- Steps:
  - Start with an empty database (or temporarily rename database)
  - Start the server
  - Observe console logs for "Default Admin Created" and the printed credentials
  - Call health endpoint and confirm `adminExists: true`
- Expected:
  - Exactly one admin user created with email above
  - No `deleteMany()` or destructive logs should run

2) Admin login and dashboard access
- Curl:
  - Login as admin:

    curl -X POST http://localhost:5000/api/auth/login \
      -H "Content-Type: application/json" \
      -d '{"gymId":"MAIN","email":"shivadas01635@gmail.com","password":"a1fitness2026"}'

- Expected:
  - Receive `accessToken` and `refreshToken` cookie
  - `user.role` is `admin`

3) Signup flow (member)
- Steps:
  - Call signup endpoint (role field must not be provided)

    curl -X POST http://localhost:5000/api/auth/signup \
      -H "Content-Type: application/json" \
      -d '{"gymId":"MAIN","name":"Test Member","email":"test.member@example.com","password":"testpass"}'

- Expected:
  - User created with `role: member` and `status: pending`
  - Member document created with `status: pending` and `paymentStatus: pending`
  - Response contains sanitized user and access token but member cannot access dashboard

4) Pending member login blocked
- Steps:
  - Attempt login with the pending member

    curl -X POST http://localhost:5000/api/auth/login \
      -H "Content-Type: application/json" \
      -d '{"gymId":"MAIN","email":"test.member@example.com","password":"testpass"}'

- Expected:
  - 403 response with message: "Your account is pending approval. Please wait for admin approval."

5) Admin approves member
- Steps:
  - As admin, use `GET /api/members` to find member id, then call approval:

    curl -X POST http://localhost:5000/api/members/:id/approve \
      -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>"

- Expected:
  - Member `status` becomes `active`
  - Corresponding `User` status set to `active`
  - Member can login successfully afterwards

6) Trainer creation (admin action)
- Steps:
  - Admin creates a trainer via user creation endpoint (or seed manually)
- Expected:
  - New user with `role: trainer` created
  - Trainer can be assigned to a member

7) Assign plan and payment flow
- Steps:
  - Admin/trainer assigns a plan to member using assign endpoint
  - Mark payment via the payments endpoints (simulate `status: paid`)
- Expected:
  - `member.paymentStatus` becomes `paid` and `isActivePlan` toggles appropriately

8) Password reset flow
- Steps:
  - Call `/api/auth/forgot-password` with a registered email
  - Confirm server logs a reset URL (or email in production)
  - Use token in `/api/auth/reset-password/:token` to set a new password
- Expected:
  - Reset returns success and the user can login with new password

Edge cases and negative tests

- Attempt signup with `role: admin` or `role: trainer` in body: should be ignored and user created as member
- Attempt to create a second default admin on non-empty DB: seed should skip creation
- Attempt login with wrong password: 401 INVALID_CREDENTIALS
- Attempt to approve member by non-admin: should return 403 (test RBAC routes)
- Ensure no endpoint runs `deleteMany()` on startup or on regular API calls

Automated test suggestions

- Unit tests (Jest + supertest):
  - `auth.test.js`: seed hook, signup, login pending/active flows, refresh, logout
  - `member.test.js`: create member, approve member, assign plan, delete member cascade
  - `seed.test.js`: run seedData() against an in-memory mongo (mongodb-memory-server) and assert admin creation only when no admin exists

- Postman / Newman collection:
  - Export a collection that runs: health -> signup -> login (expect pending) -> admin login -> approve -> login (expect success)

Acceptance criteria (deliverable ready for client)

- Default admin auto-created on fresh DB with provided credentials
- Signup always creates `member` with `pending` state
- Pending members cannot login or access dashboard
- Admin can approve members which activates their account
- No destructive seeding or `deleteMany()` on server start
- Clear console logs show when admin is created and credentials to use

Next steps I can do for you

- Generate a Postman collection with the curl requests above
- Add Jest + supertest test files and a `npm test` script
- Run the seed test against an in-memory MongoDB and show results

File created: [server/TEST_PLAN.md](server/TEST_PLAN.md#L1)

If you want me to proceed, tell me whether you prefer a Postman collection or Jest tests next.