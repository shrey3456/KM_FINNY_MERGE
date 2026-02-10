# Operations Management System Specification

## Overview
Create a full-stack operations management system for manufacturing processes with the following core modules:
- Loading Operations (GJ Operations)
- Product Management
- Proforma Slips
- Reporting Dashboard

## Tech Stack
- Frontend: React with TypeScript, Tailwind CSS, and Shadcn UI components
- Backend: Express.js with TypeScript
- Database: PostgreSQL with Drizzle ORM
- Authentication: Session-based using Express-session

## Core Features

### 1. Loading Operations Module
- Table view of all loading operations with status filtering (LOADING, READY/DESP)
- Operations have: reference number, date, status, customer data, and items
- Edit dialog with multiple tabs:
  - Details tab: operation metadata (reference, date, customer info)
  - Items tab: table of all products with quantities
  - Basket tab: filtered view of items with quantity less than 15
- Item management:
  - Each item has: product reference, quantity, loaded status, loaded quantity
  - Ability to edit items individually with proper validation
- Toggle switch to filter operations by logged-in user

### 2. Product Management
- CRUD operations for products
- Product properties: ID, name, SKU/barcode, volume, dimensions
- Search and filter capabilities
- Bulk import/export functionality

### 3. Proforma Slips
- Generate printable proforma documents based on operations
- Link proforma slips to loading operations
- Store and retrieve historical proforma data
- Track status changes (printed, confirmed, etc.)

### 4. UI/UX Requirements
- Modern, responsive design using Shadcn UI components
- Dialog-based editing with proper accessibility attributes
- Tab-based interfaces for complex forms
- Real-time validation
- Toasts for notifications
- Loading states and error handling

### 5. Database Schema
- Operations table with metadata
- Operation items linking to products
- Products catalog
- User accounts
- Audit logging

### 6. API Endpoints
- RESTful API structure
- Operations CRUD with status filtering
- Products CRUD
- User authentication
- Reporting endpoints

## Implementation Notes
- Use React Query for data fetching and caching
- Implement proper state management with React hooks
- Use Shadcn UI for consistent styling and components
- Ensure all dialogs include proper accessibility attributes
- Add loading states for all async operations
- Create responsive layouts for all screen sizes