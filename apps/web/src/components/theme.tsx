import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ToggleGroup } from 'radix-ui'

const themeOptions = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
] as const
type Theme = typeof themeOptions[number]['value']
export type Appearance = { theme: Theme; setTheme: (theme: Theme) => void }

function savedPreference(): Theme {
  try {
    const value = localStorage.getItem('skyscrape-theme')
    if (value === 'light' || value === 'dark') return value
  } catch { /* Appearance still works when storage is blocked. */ }
  return 'system'
}

export function useAppearance(): Appearance {
  const [theme, setTheme] = useState(savedPreference)
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (query.matches ? 'dark' : 'light') : theme
    }
    update()
    try { localStorage.setItem('skyscrape-theme', theme) } catch { /* Storage is optional. */ }
    if (theme === 'system') {
      query.addEventListener('change', update)
      return () => query.removeEventListener('change', update)
    }
  }, [theme])
  return { theme, setTheme }
}

export function AppearanceControl({ appearance }: { appearance: Appearance }) {
  return <div className="appearance-block">
    <div className="appearance-label" aria-hidden="true">Appearance</div>
    <ToggleGroup.Root type="single" value={appearance.theme} className="appearance" aria-label="Appearance"
      onValueChange={value => {
        const choice = themeOptions.find(option => option.value === value)
        if (choice) appearance.setTheme(choice.value)
      }}>
      {themeOptions.map(({ value, label, Icon }) => <ToggleGroup.Item key={value} value={value}>
        <Icon size={15} aria-hidden="true" />{label}
      </ToggleGroup.Item>)}
    </ToggleGroup.Root>
  </div>
}
