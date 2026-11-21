import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './app/app'
import './styles/app.css'

const root = document.getElementById('root')
if (!root) throw Error('App root is missing')
createRoot(root).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>)
