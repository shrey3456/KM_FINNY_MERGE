import React from 'react';
import finnyLogo from '@assets/finny-logo.png';

interface HomeHeaderProps {
  subtitle?: string;
}

const HomeHeader: React.FC<HomeHeaderProps> = ({ subtitle }) => {
  return (
    <div className="flex flex-col items-center py-6 pb-8 w-full bg-white">
      <div className="flex items-center justify-center w-full">
        <img 
          src={finnyLogo} 
          alt="Finny Logo" 
          className="h-20 w-auto"
        />
      </div>
      
      <div className="mt-4 text-center">
        {subtitle && <p className="text-md text-gray-600 mt-1 font-semibold">{subtitle}</p>}
      </div>
      
      <div className="w-full max-w-md mx-auto mt-4 border-b border-gray-200"></div>
    </div>
  );
};

export default HomeHeader;