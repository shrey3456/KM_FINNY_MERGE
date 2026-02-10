import React from 'react';

interface QuicklineIconProps {
  className?: string;
}

const QuicklineIcon: React.FC<QuicklineIconProps> = ({ className }) => {
  return (
    <svg 
      width="24" 
      height="24" 
      viewBox="0 0 24 24" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path 
        d="M12 2L2 7L12 12L22 7L12 2Z" 
        fill="#001d6e" 
        stroke="#001d6e" 
        strokeWidth="1.5" 
        strokeLinecap="round" 
        strokeLinejoin="round"
      />
      <path 
        d="M2 17L12 22L22 17" 
        fill="none" 
        stroke="#001d6e" 
        strokeWidth="1.5" 
        strokeLinecap="round" 
        strokeLinejoin="round"
      />
      <path 
        d="M2 12L12 17L22 12" 
        fill="none" 
        stroke="#001d6e" 
        strokeWidth="1.5" 
        strokeLinecap="round" 
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default QuicklineIcon;