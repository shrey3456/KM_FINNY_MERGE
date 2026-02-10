import React from 'react';

interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
}

const PageContainer: React.FC<PageContainerProps> = ({ 
  children,
  className = ''
}) => {
  return (
    <div className={`px-4 w-full ${className}`}>
      {children}
    </div>
  );
};

export default PageContainer;