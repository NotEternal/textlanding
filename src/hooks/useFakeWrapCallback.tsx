import { Trans } from '@lingui/macro'
import { Currency } from '@uniswap/sdk-core'
import { useWeb3React } from '@web3-react/core'
import { WRAPPED_NATIVE_CURRENCY } from 'constants/tokens'
import useNativeCurrency from 'lib/hooks/useNativeCurrency'
import tryParseCurrencyAmount from 'lib/utils/tryParseCurrencyAmount'
import { useMemo, useState } from 'react'
import { useModifiedTokens, useNativeBalance, useSetModifiedToken, useSetNativeBalance } from 'state/user/hooks'
import { addBalance, formatBalance, subtractBalance } from 'utils/balances'

import { useCurrencyBalance } from '../state/connection/hooks'
import { useTransactionAdder } from '../state/transactions/hooks'
import { TransactionType } from '../state/transactions/types'
import { useBlankTransaction } from './useBlankTransaction'
import { useWETHContract } from './useContract'

export enum WrapType {
  NOT_APPLICABLE,
  WRAP,
  UNWRAP,
}

const NOT_APPLICABLE = { wrapType: WrapType.NOT_APPLICABLE }

enum WrapInputError {
  NO_ERROR, // must be equal to 0 so all other errors are truthy
  ENTER_NATIVE_AMOUNT,
  ENTER_WRAPPED_AMOUNT,
  INSUFFICIENT_NATIVE_BALANCE,
  INSUFFICIENT_WRAPPED_BALANCE,
}

export function WrapErrorText({ wrapInputError }: { wrapInputError: WrapInputError }) {
  const { chainId } = useWeb3React()
  const native = useNativeCurrency(chainId)
  const wrapped = native?.wrapped

  switch (wrapInputError) {
    case WrapInputError.NO_ERROR:
      return null
    case WrapInputError.ENTER_NATIVE_AMOUNT:
      return <Trans>Enter {native?.symbol} amount</Trans>
    case WrapInputError.ENTER_WRAPPED_AMOUNT:
      return <Trans>Enter {wrapped?.symbol} amount</Trans>

    case WrapInputError.INSUFFICIENT_NATIVE_BALANCE:
      return <Trans>Insufficient {native?.symbol} balance</Trans>
    case WrapInputError.INSUFFICIENT_WRAPPED_BALANCE:
      return <Trans>Insufficient {wrapped?.symbol} balance</Trans>
  }
}

export default function useFakeWrapCallback(
  inputCurrency: Currency | undefined | null,
  outputCurrency: Currency | undefined | null,
  typedValue: string | undefined
): { wrapType: WrapType; execute?: () => Promise<string | undefined>; inputError?: WrapInputError } {
  const { chainId, account } = useWeb3React()
  const wethContract = useWETHContract()
  const balance = useCurrencyBalance(account ?? undefined, inputCurrency ?? undefined)
  // We can always parse the amount typed as the input currency, since wrapping is 1:1
  const inputAmount = useMemo(
    () => tryParseCurrencyAmount(typedValue, inputCurrency ?? undefined),
    [inputCurrency, typedValue]
  )
  const addTransaction = useTransactionAdder()
  const { callback: blankTransactionCallback } = useBlankTransaction(
    chainId ? WRAPPED_NATIVE_CURRENCY[chainId]?.address : undefined
  )
  const modifiedTokens = useModifiedTokens(chainId)
  const setModifiedToken = useSetModifiedToken()
  const nativeBalance = useNativeBalance(chainId)
  const setNativeBalance = useSetNativeBalance()

  // This allows an async error to propagate within the React lifecycle.
  // Without rethrowing it here, it would not show up in the UI - only the dev console.
  const [error, setError] = useState<Error>()
  if (error) throw error

  return useMemo(() => {
    if (!blankTransactionCallback) throw new Error('missing transaction callback')
    if (!wethContract || !chainId || !inputCurrency || !outputCurrency) return NOT_APPLICABLE
    const weth = WRAPPED_NATIVE_CURRENCY[chainId]
    if (!weth) return NOT_APPLICABLE

    const hasInputAmount = Boolean(inputAmount?.greaterThan('0'))
    const sufficientBalance = inputAmount && balance && !balance.lessThan(inputAmount)
    const exactAmount = inputAmount?.toExact()

    const updateBalancesAfterSwap = async () => {
      if (!exactAmount) return
      if (inputCurrency.isNative) {
        setNativeBalance(
          chainId,
          nativeBalance ? subtractBalance(nativeBalance.balance, exactAmount, 18) : formatBalance(exactAmount, 18)
        )
      } else {
        const inputToken = modifiedTokens?.[inputCurrency.address]
        if (inputToken) {
          setModifiedToken(chainId, inputCurrency.address, {
            address: inputCurrency.address,
            ...subtractBalance(inputToken.balance, exactAmount, inputCurrency.decimals),
          })
        } else {
          setModifiedToken(chainId, inputCurrency.address, {
            address: inputCurrency.address,
            ...formatBalance(exactAmount, inputCurrency.decimals),
          })
        }
      }

      if (outputCurrency.isNative) {
        setNativeBalance(
          chainId,
          nativeBalance ? addBalance(nativeBalance.balance, exactAmount, 18) : formatBalance(exactAmount, 18)
        )
      } else {
        const outputToken = modifiedTokens?.[outputCurrency.address]
        if (outputToken) {
          setModifiedToken(chainId, outputCurrency.address, {
            ...outputToken,
            ...addBalance(outputToken.balance, exactAmount, outputCurrency.decimals),
          })
        } else {
          setModifiedToken(chainId, outputCurrency.address, {
            address: outputCurrency.address,
            ...formatBalance(exactAmount, outputCurrency.decimals),
          })
        }
      }
    }

    if (inputCurrency.isNative && weth.equals(outputCurrency)) {
      return {
        wrapType: WrapType.WRAP,
        execute:
          sufficientBalance && inputAmount
            ? async () => {
                const network = await wethContract.provider.getNetwork()
                if (
                  network.chainId !== chainId ||
                  wethContract.address !== WRAPPED_NATIVE_CURRENCY[network.chainId]?.address
                ) {
                  const error = new Error(`Invalid WETH contract
Please file a bug detailing how this happened - https://github.com/Uniswap/interface/issues/new?labels=bug&template=bug-report.md&title=Invalid%20WETH%20contract`)
                  setError(error)
                  throw error
                }
                const response = await blankTransactionCallback()
                addTransaction(response, {
                  type: TransactionType.WRAP,
                  unwrapped: false,
                  currencyAmountRaw: inputAmount?.quotient.toString(),
                  chainId,
                })
                await updateBalancesAfterSwap()
                return response.hash
              }
            : undefined,
        inputError: sufficientBalance
          ? undefined
          : hasInputAmount
          ? WrapInputError.INSUFFICIENT_NATIVE_BALANCE
          : WrapInputError.ENTER_NATIVE_AMOUNT,
      }
    } else if (weth.equals(inputCurrency) && outputCurrency.isNative) {
      return {
        wrapType: WrapType.UNWRAP,
        execute:
          sufficientBalance && inputAmount
            ? async () => {
                try {
                  const response = await blankTransactionCallback()
                  addTransaction(response, {
                    type: TransactionType.WRAP,
                    unwrapped: true,
                    currencyAmountRaw: inputAmount?.quotient.toString(),
                    chainId,
                  })
                  await updateBalancesAfterSwap()
                  return response.hash
                } catch (error) {
                  console.error('Could not withdraw', error)
                  throw error
                }
              }
            : undefined,
        inputError: sufficientBalance
          ? undefined
          : hasInputAmount
          ? WrapInputError.INSUFFICIENT_WRAPPED_BALANCE
          : WrapInputError.ENTER_WRAPPED_AMOUNT,
      }
    } else {
      return NOT_APPLICABLE
    }
  }, [
    wethContract,
    chainId,
    inputCurrency,
    outputCurrency,
    inputAmount,
    balance,
    addTransaction,
    blankTransactionCallback,
    modifiedTokens,
    nativeBalance,
    setModifiedToken,
    setNativeBalance,
  ])
}