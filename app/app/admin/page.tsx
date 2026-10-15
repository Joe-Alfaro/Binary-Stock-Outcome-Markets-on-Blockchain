import type { Metadata } from 'next'
import { AdminPage } from '../../src/components'

export const metadata: Metadata = { title: 'Admin · Meridian' }

export default function Admin() {
  return <AdminPage />
}
