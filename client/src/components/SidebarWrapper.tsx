import React from 'react';
import Sidebar from './Sidebar';

export const SidebarWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 pl-[64px] sm:pl-[240px]">
        {children}
      </div>
    </div>
  );
};