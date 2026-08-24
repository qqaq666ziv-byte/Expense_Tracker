import React, { createContext, useContext, useState, useEffect } from 'react';
import { themes, type Theme, type ThemeId } from '../themeConfig';

interface ThemeContextType {
  theme: Theme;
  setTheme: (themeId: ThemeId) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [themeId, setThemeIdState] = useState<ThemeId>(() => {
    try {
      const saved = localStorage.getItem('pet-theme-id');
      return saved === 'mix' ? 'mix' : 'shiba';
    } catch {
      return 'shiba';
    }
  });

  const setTheme = (id: ThemeId) => {
    setThemeIdState(id);
    try {
      localStorage.setItem('pet-theme-id', id);
    } catch {
      // The in-memory theme remains usable when browser storage is unavailable.
    }
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
