;; Fiducia - Crowdfunding Smart Contract

;; Data Maps
(define-map claim-count
  principal 
  uint
)

(define-map badges
  principal 
  bool
)

(define-data-var campaign-counter uint u0)

(define-map campaigns
  uint
  {
    creator: principal,
    goal: uint,
    raised: uint,
    deadline: uint,
    claimed: bool
  }
)

(define-map donations
  {id: uint, funder: principal}
  {
    amount: uint
  }
)

;; Error Constants
(define-constant ERR-INVALID-DEADLINE u400)
(define-constant ERR-CAMPAIGN-EXPIRED u401)
(define-constant ERR-INVALID-AMOUNT u402)
(define-constant ERR-UNAUTHORIZED u403)
(define-constant ERR-NOT-FOUND u404)
(define-constant ERR-TOO-EARLY u405)
(define-constant ERR-GOAL-NOT-MET u406)
(define-constant ERR-ALREADY-CLAIMED u407)
(define-constant ERR-TRANSFER-FAILED u408)
(define-constant ERR-INVALID-GOAL u409)
(define-constant ERR-DEADLINE-TOO-FAR u410)
(define-constant ERR-NO-DONATION u411)
(define-constant ERR-REFUND-UNAVAILABLE u412)

;; Constants for validation
(define-constant MIN-GOAL u1000000) ;; Minimum goal: 1 STX (in microSTX)
(define-constant MAX-GOAL u1000000000000) ;; Maximum goal: 1M STX
(define-constant MIN-DONATION u100000) ;; Minimum donation: 0.1 STX
(define-constant MAX-CAMPAIGN-DURATION u52560) ;; ~1 year in blocks (assuming 10min blocks)

;; Input validation functions
(define-private (is-valid-goal (goal uint))
  (and (>= goal MIN-GOAL) (<= goal MAX-GOAL))
)

(define-private (is-valid-deadline (deadline uint))
  (let ((now stacks-block-height))
    (and 
      (> deadline now)
      (<= (- deadline now) MAX-CAMPAIGN-DURATION)
    )
  )
)

(define-private (is-valid-amount (amount uint))
  (>= amount MIN-DONATION)
)

(define-private (is-valid-campaign-id (id uint))
  (< id (var-get campaign-counter))
)

;; Create a new crowdfunding campaign
(define-public (create-campaign (goal uint) (deadline uint))
  (let (
    (id (var-get campaign-counter))
    (now stacks-block-height)
  )
    ;; Validate inputs
    (asserts! (is-valid-goal goal) (err ERR-INVALID-GOAL))
    (asserts! (is-valid-deadline deadline) (err ERR-INVALID-DEADLINE))
    
    (begin
      (map-set campaigns
        id
        {
          creator: tx-sender,
          goal: goal,
          raised: u0,
          deadline: deadline,
          claimed: false
        }
      )
      (var-set campaign-counter (+ id u1))
      (ok id)
    )
  )
)

;; Donate STX to a campaign
(define-public (donate (id uint) (amount uint))
  (let (
    (campaign (map-get? campaigns id))
    (donation-key {id: id, funder: tx-sender})
  )
    ;; Validate inputs
    (asserts! (is-valid-campaign-id id) (err ERR-NOT-FOUND))
    (asserts! (is-valid-amount amount) (err ERR-INVALID-AMOUNT))
    
    (match campaign
      data
      (let (
        (existing-donation (default-to {amount: u0} (map-get? donations donation-key)))
      )
        (begin
          ;; Additional validation with campaign data
          (asserts! (< stacks-block-height (get deadline data)) (err ERR-CAMPAIGN-EXPIRED))
          
          ;; Process donation
          (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
          (map-set campaigns id
            {
              creator: (get creator data),
              goal: (get goal data),
              raised: (+ (get raised data) amount),
              deadline: (get deadline data),
              claimed: (get claimed data)
            }
          )
          (map-set donations donation-key
            {amount: (+ (get amount existing-donation) amount)}
          )
          (ok amount)
        )
      )
      (err ERR-NOT-FOUND)
    )
  )
)

;; Request a refund from an unsuccessful campaign
(define-public (request-refund (id uint))
  (let (
    (maybe-campaign (map-get? campaigns id))
    (donation-key {id: id, funder: tx-sender})
  )
    (asserts! (is-valid-campaign-id id) (err ERR-NOT-FOUND))
    
    (match maybe-campaign
      campaign
      (let (
        (now stacks-block-height)
        (goal (get goal campaign))
        (raised (get raised campaign))
        (deadline (get deadline campaign))
        (claimed (get claimed campaign))
        (creator (get creator campaign))
        (maybe-donation (map-get? donations donation-key))
      )
        (asserts! (>= now deadline) (err ERR-TOO-EARLY))
        (asserts! (< raised goal) (err ERR-REFUND-UNAVAILABLE))
        (match maybe-donation
          donation
          (let (
            (amount (get amount donation))
          )
            (asserts! (> amount u0) (err ERR-NO-DONATION))
            (asserts! (>= raised amount) (err ERR-REFUND-UNAVAILABLE))
            (try! (stx-transfer? amount (as-contract tx-sender) tx-sender))
            (map-set campaigns id
              {
                creator: creator,
                goal: goal,
                raised: (- raised amount),
                deadline: deadline,
                claimed: claimed
              }
            )
            (map-delete donations donation-key)
            (ok amount)
          )
          (err ERR-NO-DONATION)
        )
      )
      (err ERR-NOT-FOUND)
    )
  )
)

;; Claim funds from a successful campaign
(define-public (claim-funds (id uint))
  (let (
    (maybe-campaign (map-get? campaigns id))
  )
    ;; Validate input
    (asserts! (is-valid-campaign-id id) (err ERR-NOT-FOUND))
    
    (match maybe-campaign
      data
      (let (
        (now stacks-block-height)
        (goal (get goal data))
        (raised (get raised data))
        (deadline (get deadline data))
        (creator (get creator data))
        (claimed (get claimed data))
      )
        ;; Validate conditions
        (asserts! (is-eq tx-sender creator) (err ERR-UNAUTHORIZED))
        (asserts! (>= now deadline) (err ERR-TOO-EARLY))
        (asserts! (>= raised goal) (err ERR-GOAL-NOT-MET))
        (asserts! (not claimed) (err ERR-ALREADY-CLAIMED))
        
        ;; Process claim
        (try! (as-contract (stx-transfer? raised tx-sender creator)))
        (map-set campaigns id
          {
            creator: creator,
            goal: goal,
            raised: raised,
            deadline: deadline,
            claimed: true
          }
        )
        (unwrap-panic (update-claim-count creator))
        (ok true)
      )
      (err ERR-NOT-FOUND)
    )
  )
)

;; Update claim count and award badges
(define-private (update-claim-count (user principal))
  (let (
    (prev-count (default-to u0 (map-get? claim-count user)))
    (new-count (+ prev-count u1))
  )
    (begin
      (map-set claim-count user new-count)
      (if (and (>= new-count u2)
               (is-none (map-get? badges user)))
        (map-set badges user true)
        true
      )
      (ok true)
    )
  )
)

;; Read-only functions

;; Get campaign details
(define-read-only (get-campaign (id uint))
  (if (is-valid-campaign-id id)
    (match (map-get? campaigns id)
      campaign (ok campaign)
      (err ERR-NOT-FOUND)
    )
    (err ERR-NOT-FOUND)
  )
)

;; Get donation amount for a specific user and campaign
(define-read-only (get-donations (id uint) (user principal))
  (if (is-valid-campaign-id id)
    (match (map-get? donations {id: id, funder: user})
      donation (ok (get amount donation))
      (ok u0)
    )
    (ok u0)
  )
)

;; Check if user has a badge
(define-read-only (has-badge (user principal))
  (ok (is-some (map-get? badges user)))
)

;; Get current campaign counter
(define-read-only (get-campaign-counter)
  (ok (var-get campaign-counter))
)

;; Get claim count for a user
(define-read-only (get-claim-count (user principal))
  (ok (default-to u0 (map-get? claim-count user)))
)

;; Additional read-only functions for validation info
(define-read-only (get-validation-constants)
  (ok {
    min-goal: MIN-GOAL,
    max-goal: MAX-GOAL,
    min-donation: MIN-DONATION,
    max-campaign-duration: MAX-CAMPAIGN-DURATION
  })
)
