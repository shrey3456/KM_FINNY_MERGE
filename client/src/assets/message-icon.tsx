import React from 'react';

interface MessageIconProps {
  className?: string;
}

const MessageIcon: React.FC<MessageIconProps> = ({ className }) => {
  return (
    <svg 
      viewBox="0 0 512 463" 
      fill="currentColor" 
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      stroke="currentColor"
      strokeWidth="12"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path 
        fill="none"
        stroke="currentColor" 
        strokeWidth="48"
        d="M256 25C134.6 25 32 106.8 32 208.8c0 71.3 47.1 134 117.5 163.7v66.5L255.8 384h.2c121.4 0 224-81.5 224-175.8S377.4 25 256 25z"
      />
      <circle cx="160" cy="208.8" r="32" fill="currentColor" stroke="none"/>
      <circle cx="256" cy="208.8" r="32" fill="currentColor" stroke="none"/>
      <circle cx="352" cy="208.8" r="32" fill="currentColor" stroke="none"/>
    </svg>
  );
};

export default MessageIcon;