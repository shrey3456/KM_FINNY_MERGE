import { useState, useEffect } from 'react';

export interface User {
  id: number;
  userCode: string | null;
  username: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  designation: string | null;
  department: string | null;
  accessType: string | null;
  role: string;
}

export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  useEffect(() => {
    // Try to get user from localStorage
    const userStr = localStorage.getItem('currentUser');
    if (userStr) {
      try {
        const userData = JSON.parse(userStr);
        setUser(userData);
      } catch (error) {
        console.error('Error parsing user data from localStorage:', error);
        localStorage.removeItem('currentUser');
      }
    }
    setIsLoading(false);
  }, []);
  
  const updateUser = (userData: User) => {
    localStorage.setItem('currentUser', JSON.stringify(userData));
    setUser(userData);
  };
  
  const clearUser = () => {
    localStorage.removeItem('currentUser');
    setUser(null);
  };
  
  return {
    user,
    isLoading,
    updateUser,
    clearUser
  };
}