import React, { createContext, useContext, useState, useEffect } from 'react';
import { Theme, themes } from '../themeConfig';

interface ThemeContextType {
  theme: Theme;
  setTheme: (themeId: 'shiba' | 'mix') => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [themeId, setThemeIdState] = useState<'shiba' | 'mix'>(() => {
    const saved = localStorage.getItem('pet-theme-id');
    return saved === 'mix' ? 'mix' : 'shiba';
  });

  const setTheme = (id: 'shiba' | 'mix') => {
    setThemeIdState(id);
    localStorage.setItem('pet-theme-id', id);
  };

  const toggleTheme = () => {
    setTheme(themeId === 'shiba' ? 'mix' : 'shiba');
  };

  const theme = themes[themeId];

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
