import React from 'react';
import PropTypes from 'prop-types';
import { graphql } from '@apollo/client/react/hoc';
import { find, get, isNil, pick } from 'lodash';
import memoizeOne from 'memoize-one';
import { defineMessages, FormattedMessage, injectIntl } from 'react-intl';
import styled from 'styled-components';

import { CollectiveType } from '../../lib/constants/collectives';
import { getGQLV2FrequencyFromInterval } from '../../lib/constants/intervals';
import { GQLV2_PAYMENT_METHOD_TYPES } from '../../lib/constants/payment-methods';
import { TierTypes } from '../../lib/constants/tiers-types';
import { TransactionTypes } from '../../lib/constants/transactions';
import { getEnvVar } from '../../lib/env-utils';
import { formatErrorMessage, getErrorFromGraphqlException } from '../../lib/errors';
import { API_V2_CONTEXT, gqlV2 } from '../../lib/graphql/helpers';
import { addCreateCollectiveMutation } from '../../lib/graphql/mutations';
import { getStripe, stripeTokenToPaymentMethod } from '../../lib/stripe';
import { getDefaultTierAmount, getTierMinAmount, isFixedContribution } from '../../lib/tier-utils';
import { objectToQueryString } from '../../lib/url_helpers';
import { getWebsiteUrl, parseToBoolean } from '../../lib/utils';
import { Router } from '../../server/pages';

import Container from '../../components/Container';
import NewContributeFAQ from '../../components/faqs/NewContributeFAQ';
import { Box, Grid } from '../../components/Grid';
import SignInOrJoinFree, { addSignupMutation } from '../../components/SignInOrJoinFree';

import { isValidExternalRedirect } from '../../pages/external-redirect';
import Loading from '../Loading';
import MessageBox from '../MessageBox';
import Steps from '../Steps';
import { withUser } from '../UserProvider';

import { STEPS } from './constants';
import ContributionFlowButtons from './ContributionFlowButtons';
import ContributionFlowHeader from './ContributionFlowHeader';
import ContributionFlowMainContainer from './ContributionFlowMainContainer';
import ContributionFlowStepsProgress from './ContributionFlowStepsProgress';
import SafeTransactionMessage from './SafeTransactionMessage';
import { getGQLV2AmountInput, getTotalAmount, NEW_CREDIT_CARD_KEY, taxesMayApply } from './utils';

const StepsProgressBox = styled(Box)`
  min-height: 120px;
  max-width: 450px;

  @media screen and (max-width: 640px) {
    width: 100%;
    max-width: 100%;
  }
`;

const stepsLabels = defineMessages({
  contributeAs: {
    id: 'contribute.step.contributeAs',
    defaultMessage: 'Contribute as',
  },
  details: {
    id: 'contribute.step.details',
    defaultMessage: 'Details',
  },
  payment: {
    id: 'contribute.step.payment',
    defaultMessage: 'Payment info',
  },
  summary: {
    id: 'contribute.step.summary',
    defaultMessage: 'Summary',
  },
});

class ContributionFlow extends React.Component {
  static propTypes = {
    collective: PropTypes.shape({
      slug: PropTypes.string.isRequired,
      currency: PropTypes.string.isRequired,
      platformContributionAvailable: PropTypes.bool,
      parent: PropTypes.shape({
        slug: PropTypes.string,
      }),
    }).isRequired,
    host: PropTypes.object.isRequired,
    tier: PropTypes.object,
    intl: PropTypes.object,
    createUser: PropTypes.func,
    createOrder: PropTypes.func.isRequired,
    confirmOrder: PropTypes.func.isRequired,
    fixedInterval: PropTypes.string,
    fixedAmount: PropTypes.number,
    platformContribution: PropTypes.number,
    skipStepDetails: PropTypes.bool,
    step: PropTypes.string,
    redirect: PropTypes.string,
    verb: PropTypes.string,
    /** @ignore from withUser */
    refetchLoggedInUser: PropTypes.func,
    /** @ignore from withUser */
    LoggedInUser: PropTypes.object,
    createCollective: PropTypes.func.isRequired, // from mutation
  };

  constructor(props) {
    super(props);
    this.mainContainerRef = React.createRef();
    this.state = {
      error: null,
      stripe: null,
      isSubmitted: false,
      isSubmitting: false,
      stepProfile: null,
      stepPayment: null,
      stepSummary: null,
      stepDetails: {
        quantity: 1,
        interval: props.fixedInterval || props.tier?.interval,
        amount: props.fixedAmount || getDefaultTierAmount(props.tier),
        platformContribution: props.platformContribution,
      },
    };
  }

  submitOrder = async () => {
    const { stepDetails, stepProfile, stepSummary } = this.state;
    // TODO We're still relying on profiles from V1 (LoggedInUser)
    const fromAccount = typeof stepProfile.id === 'string' ? { id: stepProfile.id } : { legacyId: stepProfile.id };
    this.setState({ error: null });
    console.log('TIER', JSON.stringify(this.props.tier));
    try {
      const response = await this.props.createOrder({
        variables: {
          order: {
            quantity: stepDetails.quantity,
            amount: { valueInCents: stepDetails.amount },
            frequency: getGQLV2FrequencyFromInterval(stepDetails.interval),
            fromAccount,
            toAccount: pick(this.props.collective, ['id']),
            customData: stepDetails.customData,
            paymentMethod: await this.getPaymentMethod(),
            platformContributionAmount: getGQLV2AmountInput(stepDetails.platformContribution, undefined),
            tier: this.props.tier && { legacyId: this.props.tier.legacyId },
            taxes: stepSummary && [
              {
                type: 'VAT',
                amount: getGQLV2AmountInput(stepSummary.amount, 0),
                country: stepSummary.countryISO,
                idNumber: stepSummary.number,
              },
            ],
          },
        },
      });

      return this.handleOrderResponse(response.data.createOrder);
    } catch (e) {
      this.showError(getErrorFromGraphqlException(e));
    }
  };

  handleOrderResponse = async ({ order, stripeError }) => {
    if (stripeError) {
      return this.handleStripeError(order, stripeError);
    } else {
      return this.handleSuccess(order);
    }
  };

  handleStripeError = async (order, stripeError) => {
    const { message, account, response } = stripeError;
    if (!response) {
      this.setState({ isSubmitting: false, error: message });
    } else if (response.paymentIntent) {
      const stripe = await getStripe(null, account);
      const result = await stripe.handleCardAction(response.paymentIntent.client_secret);
      if (result.error) {
        this.setState({ isSubmitting: false, error: result.error.message });
      } else if (result.paymentIntent && result.paymentIntent.status === 'requires_confirmation') {
        this.setState({ isSubmitting: true, error: null });
        try {
          const response = await this.props.confirmOrder({ variables: { order: { id: order.id } } });
          return this.handleOrderResponse(response.data.confirmOrder);
        } catch (e) {
          this.setState({ isSubmitting: false, error: e.message });
        }
      }
    }
  };

  handleSuccess = async order => {
    this.setState({ isSubmitted: true });
    this.props.refetchLoggedInUser(); // to update memberships

    if (isValidExternalRedirect(this.props.redirect)) {
      const url = new URL(this.props.redirect);
      url.searchParams.set('orderId', order.legacyId);
      url.searchParams.set('orderIdV2', order.id);
      url.searchParams.set('status', order.status);
      const transaction = find(order.transactions, { type: TransactionTypes.CREDIT });
      if (transaction) {
        url.searchParams.set('transactionid', transaction.legacyId);
        url.searchParams.set('transactionIdV2', transaction.id);
      }

      const newFlowIsDefault = this.isNewFlowTheDefault();
      const verb = newFlowIsDefault ? 'donate' : 'new-donate';
      const fallback = `/${this.props.collective.slug}/${verb}/success?OrderId=${order.id}`;
      await Router.pushRoute('external-redirect', { url: url.href, fallback });
      return this.scrollToTop();
    } else {
      return this.pushStepRoute('success', { OrderId: order.id });
    }
  };

  showError = error => {
    this.setState({ error });
    this.scrollToTop();
  };

  getPaymentMethod = async () => {
    const { stepPayment, stripe } = this.state;
    if (!stepPayment?.paymentMethod) {
      return null;
    } else if (stepPayment.paymentMethod.id) {
      return pick(stepPayment.paymentMethod, ['id']);
    } else if (stepPayment.key === NEW_CREDIT_CARD_KEY) {
      const { token } = await stripe.createToken();
      const pm = stripeTokenToPaymentMethod(token);
      return {
        name: pm.name,
        isSavedForLater: stepPayment.paymentMethod.isSavedForLater,
        creditCardInfo: { token: pm.token, ...pm.data },
      };
    } else if (stepPayment.paymentMethod.type === GQLV2_PAYMENT_METHOD_TYPES.PAYPAL) {
      return pick(stepPayment.paymentMethod, ['type', 'paypalInfo.token', 'paypalInfo.data']);
    } else if (stepPayment.paymentMethod.type === GQLV2_PAYMENT_METHOD_TYPES.BANK_TRANSFER) {
      return pick(stepPayment.paymentMethod, ['type']);
    }
  };

  getEmailRedirectURL() {
    let currentPath = window.location.pathname;
    if (window.location.search) {
      currentPath = currentPath + window.location.search;
    } else {
      currentPath = `${currentPath}?`;
    }
    // add 'emailRedirect' to the query so we can load the Payment step when
    // the user comes back from signing up to make a recurring contribution
    currentPath = `${currentPath.replace('profile', 'payment')}&emailRedirect=true`;
    return encodeURIComponent(currentPath);
  }

  /** Validate step profile, create new incognito/org if necessary */
  /** TODO: create profile for new org */
  validateStepProfile = async () => {
    if (!this.state.stepProfile) {
      return false;
    }

    // Check if we're creating a new profile
    if (this.state.stepProfile.id === 'incognito') {
      this.setState({ isSubmitting: true });

      try {
        const { data: result } = await this.props.createCollective(this.state.stepProfile);
        const createdProfile = result.createCollective;
        await this.props.refetchLoggedInUser();
        this.setState({ stepProfile: createdProfile, isSubmitting: false });
      } catch (error) {
        this.setState({ error: error.message, isSubmitting: false });
        window.scrollTo(0, 0);
        return false;
      }
    }

    return true;
  };

  createProfileForRecurringContributions = async data => {
    if (this.state.isSubmitting) {
      return false;
    }

    const user = pick(data, ['email', 'name']);

    this.setState({ isSubmitting: true });

    try {
      await this.props.createUser({
        variables: {
          user,
          redirect: this.getEmailRedirectURL(),
          websiteUrl: getWebsiteUrl(),
        },
      });
      await Router.pushRoute('signinLinkSent', { email: user.email });
    } catch (error) {
      this.setState({ error: error.message, isSubmitting: false });
    } finally {
      this.scrollToTop();
    }
  };

  /** Steps component callback  */
  onStepChange = async step => this.pushStepRoute(step.name);

  isNewFlowTheDefault() {
    return parseToBoolean(getEnvVar('NEW_CONTRIBUTION_FLOW'));
  }

  /** Navigate to another step, ensuring all route params are preserved */
  pushStepRoute = async (stepName, routeParams = {}) => {
    const { collective, tier, LoggedInUser } = this.props;
    const { stepDetails, stepProfile } = this.state;
    const newFlowIsDefault = this.isNewFlowTheDefault();

    const params = {
      verb: this.props.verb || (newFlowIsDefault ? 'donate' : 'new-donate'),
      collectiveSlug: collective.slug,
      step: stepName === 'details' ? undefined : stepName,
      interval: this.props.fixedInterval || undefined,
      ...pick(this.props, ['interval', 'description', 'redirect']),
      ...routeParams,
    };

    let route = newFlowIsDefault ? 'orderCollectiveNew' : 'new-donate';
    if (tier) {
      params.tierId = tier.legacyId;
      params.tierSlug = tier.slug;
      if (tier.type === 'TICKET' && collective.parent) {
        route = newFlowIsDefault ? 'orderEventTier' : 'new-order-event-tier';
        params.verb = newFlowIsDefault ? 'events' : 'new-events';
        params.collectiveSlug = collective.parent.slug;
        params.eventSlug = collective.slug;
      } else {
        route = newFlowIsDefault ? 'orderCollectiveTierNew' : 'new-contribute';
        params.verb = newFlowIsDefault ? 'contribute' : 'new-contribute'; // Enforce "contribute" verb for ordering tiers
      }
    } else if (params.verb === 'contribute' || params.verb === 'new-contribute') {
      // Never use `contribute` as verb if not using a tier (would introduce a route conflict)
      params.verb = newFlowIsDefault ? 'donate' : 'new-donate';
    }

    // Reset errors if any
    if (this.state.error) {
      this.setState({ error: null });
    }

    // Navigate to the new route
    if (stepName === 'payment' && !LoggedInUser && stepDetails?.interval) {
      await this.createProfileForRecurringContributions(stepProfile);
    } else {
      await Router.pushRoute(route, params);
    }

    this.scrollToTop();
  };

  scrollToTop = () => {
    if (this.mainContainerRef.current) {
      this.mainContainerRef.current.scrollIntoView({ behavior: 'smooth' });
    } else {
      window.scrollTo(0, 0);
    }
  };

  // Memoized helpers
  isFixedContribution = memoizeOne(isFixedContribution);
  getTierMinAmount = memoizeOne(getTierMinAmount);
  taxesMayApply = memoizeOne(taxesMayApply);

  canHaveFeesOnTop() {
    if (!this.props.collective.platformContributionAvailable) {
      return false;
    } else if (this.props.tier?.type === TierTypes.TICKET) {
      return false;
    } else if (this.state.stepProfile?.type === CollectiveType.COLLECTIVE) {
      return this.state.stepProfile.host?.id && this.state.stepProfile.host.id === this.props.host?.id;
    } else {
      return true;
    }
  }

  /** Returns the steps list */
  getSteps() {
    const { fixedInterval, fixedAmount, intl, collective, host, tier } = this.props;
    const { stepDetails, stepPayment, stepSummary } = this.state;
    const isFixedContribution = this.isFixedContribution(tier, fixedAmount, fixedInterval);
    const minAmount = this.getTierMinAmount(tier);
    const noPaymentRequired = minAmount === 0 && get(stepDetails, 'amount') === 0;
    const steps = [
      {
        name: 'details',
        label: intl.formatMessage(stepsLabels.details),
        isCompleted: Boolean(stepDetails && stepDetails.amount >= minAmount),
      },
      {
        name: 'profile',
        label: intl.formatMessage(stepsLabels.contributeAs),
        isCompleted: Boolean(this.state.stepProfile),
        validate: this.validateStepProfile,
      },
    ];

    // Hide step payment if using a free tier with fixed price
    if (!(minAmount === 0 && isFixedContribution)) {
      steps.push({
        name: 'payment',
        label: intl.formatMessage(stepsLabels.payment),
        isCompleted: true,
        validate: action => {
          if (action !== 'prev') {
            const isCompleted = Boolean(noPaymentRequired || stepPayment);
            if (isCompleted && stepPayment?.key === NEW_CREDIT_CARD_KEY) {
              return stepPayment.paymentMethod?.stripeData?.complete;
            } else {
              return isCompleted;
            }
          }
        },
      });
    }

    // Show the summary step only if the order has tax
    if (this.taxesMayApply(collective, collective.parent, host, tier)) {
      steps.push({
        name: 'summary',
        label: intl.formatMessage(stepsLabels.summary),
        isCompleted: noPaymentRequired || get(stepSummary, 'isReady', false),
      });
    }

    return steps;
  }

  getPaypalButtonProps() {
    const { stepPayment, stepDetails, stepSummary } = this.state;
    if (stepPayment?.paymentMethod?.type === GQLV2_PAYMENT_METHOD_TYPES.PAYPAL) {
      const { collective, host } = this.props;
      return {
        host: host,
        currency: collective.currency,
        style: { size: 'responsive', height: 47 },
        totalAmount: getTotalAmount(stepDetails, stepSummary), // TODO this.getTotalAmountWithTaxes(),
        onClick: () => this.setState({ isSubmitting: true }),
        onCancel: () => this.setState({ isSubmitting: false }),
        onError: e => this.setState({ isSubmitting: false, error: `PayPal error: ${e.message}` }),
        onAuthorize: pm => {
          this.setState(
            state => ({
              stepPayment: {
                ...state.stepPayment,
                paymentMethod: {
                  type: GQLV2_PAYMENT_METHOD_TYPES.PAYPAL,
                  paypalInfo: pm,
                },
              },
            }),
            this.submitOrder,
          );
        },
      };
    }
  }

  getRedirectUrlForSignIn = () => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const { stepDetails } = this.state;
    const stepDetailsParams = objectToQueryString({
      amount: stepDetails.amount / 100,
      interval: stepDetails.interval || undefined,
      quantity: stepDetails.quantity !== 1 ? stepDetails.quantity : undefined,
      platformContribution: !isNil(stepDetails.platformContribution)
        ? stepDetails.platformContribution / 100
        : undefined,
    });

    const path = window.location.pathname;
    if (window.location.search) {
      return `${path}${window.location.search}&${stepDetailsParams.slice(1)}`;
    } else {
      return `${path}${stepDetailsParams}`;
    }
  };

  render() {
    const { collective, tier, LoggedInUser, skipStepDetails } = this.props;
    const { error, isSubmitted, isSubmitting } = this.state;
    return (
      <Steps
        steps={this.getSteps()}
        currentStepName={this.props.step}
        onStepChange={this.onStepChange}
        onComplete={this.submitOrder}
        skip={skipStepDetails ? ['details'] : null}
      >
        {({
          steps,
          currentStep,
          lastVisitedStep,
          goNext,
          goBack,
          goToStep,
          prevStep,
          nextStep,
          isValidating,
          isValidStep,
        }) =>
          !isValidStep ? (
            <Loading />
          ) : (
            <Container
              display="flex"
              flexDirection="column"
              alignItems="center"
              justifyContent="center"
              py={[3, 4, 5]}
              mb={4}
              data-cy="cf-content"
              ref={this.mainContainerRef}
            >
              <Box px={[2, 3]} mb={4}>
                <ContributionFlowHeader collective={collective} />
              </Box>
              <StepsProgressBox mb={3} width={[1.0, 0.8]}>
                <ContributionFlowStepsProgress
                  steps={steps}
                  currentStep={currentStep}
                  lastVisitedStep={lastVisitedStep}
                  goToStep={goToStep}
                  stepProfile={this.state.stepProfile}
                  stepDetails={this.state.stepDetails}
                  stepPayment={this.state.stepPayment}
                  stepSummary={this.state.stepSummary}
                  isSubmitted={this.state.isSubmitted}
                  loading={isValidating || isSubmitted || isSubmitting}
                  currency={collective.currency}
                  isFreeTier={this.getTierMinAmount(tier) === 0}
                />
              </StepsProgressBox>
              {/* main container */}
              {currentStep.name === STEPS.PROFILE &&
              !LoggedInUser &&
              !parseToBoolean(getEnvVar('ENABLE_GUEST_CONTRIBUTIONS')) ? (
                <SignInOrJoinFree
                  defaultForm="create-account"
                  redirect={this.getRedirectUrlForSignIn()}
                  createPersonalProfileLabel={
                    <FormattedMessage
                      id="ContributionFlow.CreateUserLabel"
                      defaultMessage="Contribute as an individual"
                    />
                  }
                  createOrganizationProfileLabel={
                    <FormattedMessage
                      id="ContributionFlow.CreateOrganizationLabel"
                      defaultMessage="Contribute as an organization"
                    />
                  }
                />
              ) : (
                <Grid
                  px={[2, 3]}
                  gridTemplateColumns={[
                    'minmax(200px, 600px)',
                    null,
                    '0fr minmax(300px, 600px) 1fr',
                    '1fr minmax(300px, 600px) 1fr',
                  ]}
                >
                  <Box />
                  <Box as="form" onSubmit={e => e.preventDefault()} maxWidth="100%">
                    {error && (
                      <MessageBox type="error" withIcon mb={3}>
                        {formatErrorMessage(this.props.intl, error)}
                      </MessageBox>
                    )}

                    <ContributionFlowMainContainer
                      collective={collective}
                      tier={tier}
                      mainState={this.state}
                      onChange={data => this.setState(data)}
                      step={currentStep}
                      showFeesOnTop={this.canHaveFeesOnTop()}
                      onNewCardFormReady={({ stripe }) => this.setState({ stripe })}
                    />

                    <Box mt={[4, 5]}>
                      <ContributionFlowButtons
                        goNext={goNext}
                        goBack={goBack}
                        step={currentStep}
                        prevStep={prevStep}
                        nextStep={nextStep}
                        isRecurringContributionLoggedOut={Boolean(!LoggedInUser && this.state.stepDetails?.interval)}
                        isValidating={isValidating || isSubmitted || isSubmitting}
                        paypalButtonProps={this.getPaypalButtonProps()}
                      />
                    </Box>
                  </Box>
                  <Box minWidth={[null, '300px']} mt={[4, null, 0]} ml={[0, 3, 4, 5]}>
                    <Box maxWidth={['100%', null, 300]} px={[1, null, 0]}>
                      <SafeTransactionMessage />
                      <NewContributeFAQ mt={4} titleProps={{ mb: 2 }} />
                    </Box>
                  </Box>
                </Grid>
              )}
            </Container>
          )
        }
      </Steps>
    );
  }
}

export const orderSuccessFragment = gqlV2/* GraphQL */ `
  fragment OrderSuccessFragment on Order {
    id
    status
    frequency
    amount {
      value
      currency
    }
    platformContributionAmount {
      value
    }
    tier {
      id
      name
    }
    membership {
      id
      publicMessage
    }
    fromAccount {
      id
      name
    }
    toAccount {
      id
      name
      slug
      ... on AccountWithContributions {
        contributors {
          totalCount
        }
      }
      ... on AccountWithHost {
        host {
          id
          settings
          payoutMethods {
            id
            name
            data
            type
          }
        }
      }
    }
  }
`;

const orderResponseFragment = gqlV2/* GraphQL */ `
  fragment OrderResponseFragment on OrderWithPayment {
    order {
      ...OrderSuccessFragment
    }
    stripeError {
      message
      account
      response
    }
  }
  ${orderSuccessFragment}
`;

// TODO: Use a fragment to retrieve the fields from success page in there
const addCreateOrderMutation = graphql(
  gqlV2/* GraphQL */ `
    mutation CreateOrder($order: OrderCreateInput!) {
      createOrder(order: $order) {
        ...OrderResponseFragment
      }
    }
    ${orderResponseFragment}
  `,
  {
    name: 'createOrder',
    options: { context: API_V2_CONTEXT },
  },
);

const addConfirmOrderMutation = graphql(
  gqlV2/* GraphQL */ `
    mutation CreateOrder($order: OrderReferenceInput!) {
      confirmOrder(order: $order) {
        ...OrderResponseFragment
      }
    }
    ${orderResponseFragment}
  `,
  {
    name: 'confirmOrder',
    options: { context: API_V2_CONTEXT },
  },
);

export default injectIntl(
  withUser(
    addSignupMutation(addConfirmOrderMutation(addCreateOrderMutation(addCreateCollectiveMutation(ContributionFlow)))),
  ),
);
