import React from 'react';

interface ResizerProps {
  id: string;
  onMouseDown: (e: React.MouseEvent) => void;
}

export const Resizer: React.FC<ResizerProps> = ({ id, onMouseDown }) => {
  return <div className="resizer" id={id} onMouseDown={onMouseDown} />;
};
