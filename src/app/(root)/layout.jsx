import { onBoardUser } from '@/modules/auth/actions'
import Navbar from '@/modules/home/components/navbar'
import React from 'react'

export const dynamic = "force-dynamic";

const Layout = async({children}) => {
  await onBoardUser()
  return (
    <div>
      <main className='flex flex-col min-h-screen relative overflow-x-hidden'>
        <Navbar />

        <div 
        className="fixed inset-0 -z-10 h-full w-full bg-background dark:bg-[radial-gardient
        (#393e4a_1px,transparent_1px)] bg-[radial-gradient(#dadde2_1px,transparent_1px)]
        [background-size:16px_16px]" />
        <div className='flex-1 w-full mt-20'>
            {children}
        </div>
      </main>
    </div>
  )
}

export default Layout
