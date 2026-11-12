import LocalInferenceClient from './LocalInferenceClient';

export const metadata = {
  title: 'Local Inference | Open Generative AI',
  description: 'Generate images using a self-hosted sd.cpp inference server.',
};

export default function LocalInferencePage() {
  return <LocalInferenceClient />;
}
