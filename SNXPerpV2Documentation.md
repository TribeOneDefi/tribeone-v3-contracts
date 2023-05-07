## Synthetix Perpetuals User Flow (Detailed) 

### 1. Deposit Margin

The user starts by depositing some sUSD as margin into their Perpetuals account.

#### Function: `PerpsV2Market.deposit(sUSD_amount)`

- The user calls the `deposit()` function on the `PerpsV2Market` contract with the amount of sUSD they want to deposit as margin.
- The `PerpsV2Market` contract updates the user's margin balance in the `PerpsV2State` contract.

#### Contract Interaction: Synthetix Core Contracts

- The `PerpsV2Market` contract interacts with the Synthetix core contracts (`ExchangeRates`, `SystemSettings`, etc.) to fetch relevant information like exchange rates and system settings.
- The `PerpsV2Market` contract then updates the user's margin balance and the debt pool in the `PerpsV2State` contract accordingly.

#### Formulas:

- `newMargin = currentMargin + sUSD_amount`
- `PerpsV2State.margin[user] = newMargin`


### 2. Open a Position

The user can open a long or short position, specifying the leverage and the amount of sUSD they want to use for the position.

#### Function: `PerpsV2Market.submitIntentToTrade(leverage, amount, direction)`

- The user calls the `submitIntentToTrade()` function on the `PerpsV2Market` contract with the desired leverage, amount of sUSD, and direction (long or short) for the position.
- The `PerpsV2Market` contract calculates the position size and ensures that the user has enough margin to open the position, taking into account the maximum allowed leverage and minimum required margin.

#### Contract Interaction: Synthetix Core Contracts

- The `PerpsV2Market` contract interacts with the Synthetix core contracts (`ExchangeRates`, `SystemSettings`, etc.) to fetch relevant information like exchange rates and system settings.
- The `PerpsV2Market` contract then updates the user's position and the debt pool in the `PerpsV2State` contract accordingly.

#### Formulas:

- `positionSize = amount * leverage`
- `newPosition = currentPosition + positionSize * direction`
- `PerpsV2State.position[user] = newPosition`
- `PerpsV2State.debtPool += positionSize`

After the user has opened a position, they can decide to close it at any time to realize their profit or loss.

### 3. Close a Position

The user can close their position fully or partially by specifying the amount of the position they want to close.

#### Function: `PerpsV2Market.submitIntentToTrade(leverage, amount, direction)`

- The user calls the `submitIntentToTrade()` function on the `PerpsV2Market` contract with the desired leverage, amount of sUSD, and opposite direction (long or short) from their existing position for the position they want to close.
- The `PerpsV2Market` contract calculates the position size and ensures that the user has enough margin to close the position, taking into account the maximum allowed leverage and minimum required margin.

#### Contract Interaction: Synthetix Core Contracts

- The `PerpsV2Market` contract interacts with the Synthetix core contracts (`ExchangeRates`, `SystemSettings`, etc.) to fetch relevant information like exchange rates and system settings.
- The `PerpsV2Market` contract then updates the user's position, the debt pool, and the user's margin in the `PerpsV2State` contract accordingly, taking into account the profit or loss realized from closing the position.

#### Formulas:

- `positionSize = amount * leverage`
- `newPosition = currentPosition - positionSize * direction`
- `PerpsV2State.position[user] = newPosition`
- `PerpsV2State.debtPool -= positionSize`
- `profitOrLoss = (positionSize * (closingPrice - openingPrice) * direction) * (-1)`
- `PerpsV2State.margin[user] += profitOrLoss`

### 4. Withdraw Margin

The user can withdraw their margin partially or in full.

#### Function: `PerpsV2Market.withdrawMargin(amount)`

- The user calls the `withdrawMargin()` function on the `PerpsV2Market` contract with the desired amount of sUSD they want to withdraw.
- The `PerpsV2Market` contract checks if the user has enough margin available for withdrawal, taking into account any positions they still have open and the minimum required margin.
- The `PerpsV2Market` contract updates the user's margin in the `PerpsV2State` contract, subtracting the withdrawn amount.

#### Contract Interaction: Synthetix Core Contracts

- The `PerpsV2Market` contract interacts with the Synthetix core contracts (`ExchangeRates`, `SystemSettings`, etc.) to fetch relevant information like exchange rates and system settings.
- The `PerpsV2Market` contract then interacts with the `Synthetix` contract to transfer the withdrawn sUSD amount from the `PerpsV2Market` contract to the user's wallet.

#### Formulas:

- `PerpsV2State.margin[user] -= amount`

