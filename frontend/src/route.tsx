import { createHashRouter, Navigate } from 'react-router-dom';
import AppLayout from './pages/App';

export default createHashRouter([
  {
    path: '/',
    element: <Navigate replace to='/manage' />
  },
  {
    path: '/manage',
    element: <AppLayout />
  },
  {
    path: '/plugin',
    element: <AppLayout />
  },
  {
    path: '/logs',
    element: <AppLayout />
  },
  {
    path: '/data',
    element: <AppLayout />
  },
  {
    path: '/repo/:section',
    element: <AppLayout />
  },
  {
    path: '/config/:section',
    element: <AppLayout />
  },
  {
    path: '*',
    element: <Navigate replace to='/manage' />
  }
]);
