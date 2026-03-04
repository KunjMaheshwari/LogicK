"use client"

import ProjectForm from '@/modules/home/components/project-form'
import Image from 'next/image'
import React from 'react'
import ProjectList from '@/modules/home/components/project-list'

const Page = () => {
  return (
    <div className='flex items-center justify-center w-full px-4 py-8'>
      <div className='max-w-5cl w-full'>
        <section className='space-y-8 flex flex-col items-center'>
          <div className='flex flex-col items-center'>
            <Image
            src={"/LogicKLogo.svg"}
            width={100}
            height={100}
            alt='Logo'
            className='hidden md:block invert dark:invert-0' />
          </div>
          <h1 className='text-2xl md:text-5xl font-bold text-center'>Build Somthing with LogicK</h1>
          <p className='text-lg md:text-xl text-muted-foreground text-center'>
            Create apps and websites by chatting with AI
          </p>

          <div className='max-w-3xl w-full'>
            <ProjectForm />
          </div>

          <ProjectList />
        </section>
      </div>
    </div>
  )
}

export default Page
