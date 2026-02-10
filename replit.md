# KM Finny Operations Management System

## Overview

KM Finny is a comprehensive manufacturing operations management system designed to handle loading operations, inventory management, proforma slips, and business reporting. It is built as a Progressive Web App (PWA) with offline capabilities and a mobile-first design, aiming to streamline operations and enhance efficiency in manufacturing environments. The system provides real-time data fetching directly from Notion databases without requiring imports, and integrates a sophisticated dispatch preview and search system.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript.
- **Styling**: Tailwind CSS with Shadcn UI for consistent design.
- **State Management**: TanStack React Query for server state management and caching.
- **Routing**: Wouter for lightweight client-side routing.
- **Build Tool**: Vite for fast development and optimized production builds.
- **UI/UX**: Mobile-first, touch-optimized interfaces with consistent branding (KM Finny blue theme). Features like splash screen fade effect and restored original logos contribute to brand consistency.

### Backend Architecture
- **Runtime**: Node.js with Express.js server framework.
- **Language**: TypeScript for full-stack type safety.
- **API Design**: RESTful APIs with standard HTTP methods.
- **Build Process**: ESBuild for server bundling and production deployment.

### Database Layer
- **Database**: PostgreSQL for reliable relational data storage.
- **ORM**: Drizzle ORM for type-safe database operations and migrations.
- **Connection**: Neon Database serverless PostgreSQL connection.

### Core System Features & Implementations
- **Authentication System**: Session-based authentication using Express Session, custom scrypt-based password hashing, emergency admin PINs (9999, 0000), multi-level role system (read, read/write, admin, super-admin), client-side user session persistence, deployment-compatible secure cookie configuration with HTTPS support, and PIN uniqueness validation to prevent duplicate PINs across users. Role-based access control implemented for critical functionalities like Notion import.
- **Loading Operations Management**: CRUD operations for loading/dispatch, status tracking (LOADING, READY/DESP, PENDING DESP), multi-tab edit interface, real-time quantity tracking, plant-based filtering, and integration with proforma slip generation.
- **Inventory & Product Management**: Comprehensive product catalog with SKU/barcode support, volume/dimension tracking, category-based organization, and bulk import/export.
- **Proforma Slip System**: Dynamic generation from loading operations, PDF export with plant-specific branding, historical tracking, batch processing, and print-optimized layouts. Dates are formatted as DD/MM/YYYY.
- **Reporting & Analytics**: Real-time dashboard, activity logging, sales tracking, user-specific access controls, and export capabilities.
- **PWA Features**: Service worker for offline support, native-like installation prompts, and responsive design.
- **Data Integrity**: Robust handling of unmatched items, order deduplication, and item aggregation to prevent data inconsistencies.
- **Performance Optimizations**: Optimized session deserialization, intelligent query client retry logic, and improved error handling. Dispatch search performance reduced from over 135 seconds to approximately 8 seconds through API and query optimizations.
- **Dispatch Preview System**: Fetches live data from Notion databases, filters orders by "Dispatched" and "Ready for Dispatch" statuses, and is integrated into the navigation.
- **Enhanced Dispatch System**: Comprehensive dispatch management with integrated party database lookup using exact party name matching. Streamlined Order Details interface displaying only essential fields (Order Date, Order Number, Plant, Status, Party Name, Party Area, Vehicle x Driver, Invoice Number, Invoice Amount). Party contact and address information automatically sourced from dedicated party database (0da8aefd54554a75971f3726eaabcd42) for accurate contact details.
- **Notion Integration**: Triple database integration system - dispatch database (296851d9af9e4a14966376e58f8475e5), proforma database (6d5985b48f944989994635cac1795211), and party database (0da8aefd54554a75971f3726eaabcd42) with intelligent data merging and exact party name matching for reliable contact information retrieval.

## External Dependencies

### Core Dependencies
- **@tanstack/react-query**: Server state management and caching.
- **@radix-ui/***: Accessible UI primitives.
- **wouter**: Lightweight routing library.
- **drizzle-orm**: Type-safe database operations.
- **@neondatabase/serverless**: Serverless PostgreSQL connection.
- **date-fns**: Date manipulation and formatting.
- **jspdf**: PDF generation for reports and slips.

### Development Tools
- **TypeScript**: Static type checking.
- **Vite**: Development server and build tooling.
- **ESBuild**: Server-side bundling.
- **PostCSS**: CSS processing with Tailwind CSS.

### Authentication & Security
- **express-session**: Session management.
- **passport**: Authentication middleware (with local strategy).
- **crypto**: Node.js built-in for password hashing.