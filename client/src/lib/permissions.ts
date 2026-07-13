export enum UserRole {
  READ = "read",
  READ_WRITE = "read/write",
  ADMIN = "admin",
  SUPER_ADMIN = "super-admin"
}

export interface Permissions {
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canManageUsers: boolean;
  canClearData: boolean;
  canManageSettings: boolean;
  canAccessInventory: boolean;
  canDeleteOperationalItems: boolean;
  canEditReadyDespOperations: boolean;
  canAccessLoadOperations: boolean;
  canAccessMPOperations: boolean;
  canAccessSalesPage: boolean;
  canAccessOrderManagement: boolean;
}


// Check if user can access inventory based on designation only
function canUserAccessInventory(user: any): boolean {
  if (!user) return false;
  
  // Allow access if user is admin or super-admin
  if (user.role === 'admin' || user.role === 'super-admin') {
    return true;
  }
  
  // Check designation - ONLY allow access to director, head, manager
  const allowedDesignations = ['director', 'head', 'manager'];
  if (user.designation) {
    const designation = user.designation.toLowerCase();
    // Use exact match or check if word begins with the allowed designation
    if (allowedDesignations.some(allowed => 
      designation === allowed || 
      designation.startsWith(allowed + ' ') || 
      designation.includes(' ' + allowed)
    )) {
      return true;
    }
  }
  
  return false;
}

// Check if user can delete operational items based on designation
function canUserDeleteOperationalItems(user: any): boolean {
  if (!user) return false;
  
  // Allow access if user is admin or super-admin
  if (user.role === 'admin' || user.role === 'super-admin') {
    return true;
  }
  
  // Check designation - ONLY allow deletion to director, head, manager, supervisor
  const allowedDesignations = ['director', 'head', 'manager', 'supervisor'];
  if (user.designation) {
    const designation = user.designation.toLowerCase();
    
    // Explicitly exclude assistant designation
    if (designation === 'assistant' || designation.includes('assistant')) {
      return false;
    }
    
    // Use exact match or check if word begins with the allowed designation
    if (allowedDesignations.some(allowed => 
      designation === allowed || 
      designation.startsWith(allowed + ' ') || 
      designation.includes(' ' + allowed)
    )) {
      return true;
    }
  }
  
  return false;
}

// Function to check if a role is admin or super-admin
export function isAdminOrSuperAdmin(role: string): boolean {
  return role === 'admin' || role === 'super-admin';
}

// Check if user can access Load Operations based on department
function canUserAccessLoadOperations(user: any): boolean {
  if (!user) return false;
  
  // Allow access if user is admin or super-admin
  if (user.role === 'admin' || user.role === 'super-admin') {
    return true;
  }
  
  // Check department - hide from users with "DISPATCH {INDORE}" & "DISPATCH {LUCKNOW}" department
  if (user.department) {
    const department = user.department.toUpperCase();
    
    // Explicitly deny access to users from INDORE and LUCKNOW dispatch departments
    if (department === 'DISPATCH {INDORE}' || department === 'DISPATCH {LUCKNOW}') {
      return false;
    }
    
    // Only allow access to users from VALSAD, BARODA, and RAJKOT departments
    // This further restricts which users can see the Load Operations page even if they're not from INDORE/LUCKNOW
    const allowedDepartments = [
      'DISPATCH {VALSAD}', 'DISPATCH {BARODA}', 'DISPATCH {RAJKOT}',
      'MANAGEMENT {VALSAD}', 'MANAGEMENT {BARODA}', 'MANAGEMENT {RAJKOT}'
    ];
    
    // Check if user department is in the allowed list
    const isDepartmentAllowed = allowedDepartments.some(allowed => 
      department === allowed || department.includes('VALSAD') || 
      department.includes('BARODA') || department.includes('RAJKOT')
    );
    
    return isDepartmentAllowed;
  }
  
  return false; // By default, deny access
}

// Check if user can access MP Operations based on department
function canUserAccessMPOperations(user: any): boolean {
  if (!user) return false;
  
  // Allow access if user is admin or super-admin
  if (user.role === 'admin' || user.role === 'super-admin') {
    return true;
  }
  
  // Check department - hide from users with "DISPATCH {VALSAD}" department
  if (user.department) {
    const department = user.department.toUpperCase();
    
    // Explicitly deny access to VALSAD dispatch department
    if (department === 'DISPATCH {VALSAD}') {
      return false;
    }
    
    // Only allow access to users from INDORE departments
    // This further restricts which users can see the MP Operations page even if they're not from VALSAD
    const allowedDepartments = [
      'DISPATCH {INDORE}', 'MANAGEMENT {INDORE}'
    ];
    
    // Check if user department is in the allowed list
    const isDepartmentAllowed = allowedDepartments.some(allowed => 
      department === allowed || department.includes('INDORE')
    );
    
    return isDepartmentAllowed;
  }
  
  return false; // By default, deny access
}

// Check if user should see Sales page in Home screen
function canUserAccessSalesPage(user: any): boolean {
  if (!user) return false;
  
  // Allow access if user is admin or super-admin
  if (user.role === 'admin' || user.role === 'super-admin') {
    return true;
  }
  
  // Check if user is from Management or IT department
  if (user.department) {
    const department = user.department.toUpperCase();
    
    // Show Sales page if user is from management or IT department
    return department.includes('MANAGEMENT') || department.includes('IT');
  }
  
  return false; // By default, don't show Sales page
}

function canUserAccessOrderManagement(user: any): boolean {
  if (!user) return false;

  // Allow access if user is admin or super-admin
  if (user.role === 'admin' || user.role === 'super-admin') {
    return true;
  }

  // Check if user is from Order Management department
  if (user.department) {
    const department = user.department.toUpperCase();
    return department.includes('BILLING');
  }

  return false;
}

// Define default permissions for different roles
export function getPermissionsForRole(role?: string): Permissions {
  switch (role) {
    case UserRole.SUPER_ADMIN:
      return {
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canManageUsers: true,
        canClearData: true,
        canManageSettings: true,
        canAccessInventory: true,
        canDeleteOperationalItems: true,
        canEditReadyDespOperations: true,
        canAccessLoadOperations: true,
        canAccessMPOperations: true,
        canAccessSalesPage: true,
        canAccessOrderManagement: true,
      };
    case UserRole.ADMIN:
      return {
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canManageUsers: true,
        canClearData: true,
        canManageSettings: true,
        canAccessInventory: true,
        canDeleteOperationalItems: true,
        canEditReadyDespOperations: true,
        canAccessLoadOperations: true,
        canAccessMPOperations: true,
        canAccessSalesPage: true,
        canAccessOrderManagement: true,
      };
    case UserRole.READ_WRITE:
      return {
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: false,
        canManageUsers: false,
        canClearData: false,
        canManageSettings: false,
        canAccessInventory: false,
        canDeleteOperationalItems: false,
        canEditReadyDespOperations: false,
        canAccessLoadOperations: true,
        canAccessMPOperations: true,
        canAccessSalesPage: false,
        canAccessOrderManagement: false,
      };
    case UserRole.READ:
      return {
        canRead: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canManageUsers: false,
        canClearData: false,
        canManageSettings: false,
        canAccessInventory: false,
        canDeleteOperationalItems: false,
        canEditReadyDespOperations: false,
        canAccessLoadOperations: true,
        canAccessMPOperations: true,
        canAccessSalesPage: false,
        canAccessOrderManagement: false,
      };
    default:
      // Default to read-only if role is unknown
      return {
        canRead: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canManageUsers: false,
        canClearData: false,
        canManageSettings: false,
        canAccessInventory: false,
        canDeleteOperationalItems: false,
        canEditReadyDespOperations: false,
        canAccessLoadOperations: true,
        canAccessMPOperations: true,
        canAccessSalesPage: false,
        canAccessOrderManagement: false,
      };
  }
}

// Get current user permissions
export function getCurrentUserPermissions(): Permissions {
  try {
    const currentUserStr = localStorage.getItem('currentUser');
    if (!currentUserStr) {
      return getPermissionsForRole(); // Default permissions if no user
    }
    
    const currentUser = JSON.parse(currentUserStr);
    const basePermissions = getPermissionsForRole(currentUser.role);
    
    // Check if user can access inventory based on designation only
    const canAccessInventory = canUserAccessInventory(currentUser);
    
    // Check if user can delete operational items based on designation
    const canDeleteOperationalItems = canUserDeleteOperationalItems(currentUser);
    
    // Check if user can edit operations with READY≈DESP status
    // Only admin and super-admin can edit these operations
    const canEditReadyDespOperations = currentUser.role === 'admin' || currentUser.role === 'super-admin';
    
    // Check if user can access Load Operations and MP Operations based on department
    const canAccessLoadOperations = canUserAccessLoadOperations(currentUser);
    const canAccessMPOperations = canUserAccessMPOperations(currentUser);
    
    // Check if user should see Sales page based on department
    const canAccessSalesPage = canUserAccessSalesPage(currentUser);

    const canAccessOrderManagement = canUserAccessOrderManagement(currentUser);

    return {
      ...basePermissions,
      canAccessInventory,
      canDeleteOperationalItems,
      canEditReadyDespOperations,
      canAccessLoadOperations,
      canAccessMPOperations,
      canAccessSalesPage,
      canAccessOrderManagement,
    };
  } catch (error) {
    console.error('Error getting current user permissions:', error);
    return getPermissionsForRole(); // Default permissions on error
  }
}

// Per-page write access, set by admin on the User Management page (pageWriteAccess is a
// subset of allowedPages). Admin/super-admin always have full write access. A page not in
// pageWriteAccess is view-only for that user, even if it's in allowedPages. Not yet enforced
// anywhere — pages must opt in by calling this before allowing a save/edit/delete action.
export function hasPageWriteAccess(pageKey: string): boolean {
  try {
    const currentUserStr = localStorage.getItem('currentUser');
    if (!currentUserStr) return false;
    const currentUser = JSON.parse(currentUserStr);
    if (currentUser.role === 'admin' || currentUser.role === 'super-admin') return true;
    const writable: string[] = JSON.parse(currentUser.pageWriteAccess || '[]');
    return writable.includes(pageKey);
  } catch {
    return false;
  }
}