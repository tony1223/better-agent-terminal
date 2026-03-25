// @vitest-environment jsdom
import '../mocks/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { AboutPanel } from '../../src/components/AboutPanel'

describe('AboutPanel', () => {
  it('renders the title', () => {
    render(<AboutPanel onClose={() => {}} />)
    expect(screen.getByText('about.title')).toBeInTheDocument()
  })

  it('renders app name and description', () => {
    render(<AboutPanel onClose={() => {}} />)
    expect(screen.getByText('about.appName')).toBeInTheDocument()
    expect(screen.getByText('about.description')).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn()
    render(<AboutPanel onClose={onClose} />)
    await userEvent.click(screen.getByText('×'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when overlay is clicked', async () => {
    const onClose = vi.fn()
    const { container } = render(<AboutPanel onClose={onClose} />)
    // Click the overlay (outermost div)
    await userEvent.click(container.querySelector('.settings-overlay')!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not close when panel content is clicked', async () => {
    const onClose = vi.fn()
    const { container } = render(<AboutPanel onClose={onClose} />)
    await userEvent.click(container.querySelector('.about-content')!)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls electronAPI.shell.openExternal for GitHub link', async () => {
    render(<AboutPanel onClose={() => {}} />)
    const link = screen.getByText('github.com/tony1223/better-agent-terminal')
    await userEvent.click(link)
    expect(window.electronAPI.shell.openExternal).toHaveBeenCalledWith(
      'https://github.com/tony1223/better-agent-terminal'
    )
  })
})
