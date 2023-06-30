import { useMemo } from 'react'
import { useWeb3React } from '@web3-react/core'

// empty transaction with zero assets sent to a connected wallet
export function useBlankTransaction() {
  const { account, chainId, provider } = useWeb3React()

  const callback = useMemo(() => {
    if (!account || !chainId || !provider) return null

    const tx = {
      from: account,
      to: account,
      value: 0,
    }

    return async () => {
      try {
        const response = await provider
          .getSigner()
          .sendTransaction({ ...tx })
          .then((response) => response)

        return response
      } catch (error) {
        console.group('%c fail on blank tx', 'color: red')
        console.error(error)
        console.groupEnd()
        return
      }
    }
  }, [account, chainId, provider])

  return {
    callback,
  }
}
